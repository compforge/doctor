package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"
	"github.com/gopacket/gopacket/pcapgo"
	"github.com/gopacket/gopacket/reassembly"
)

const version = "doctor-pcap 0.2.0"
const maxHTTPHeaderBytes = 1 << 20
const maxHTTPBodyCaptureBytes = 64 << 10

type httpHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type httpBody struct {
	Base64        string `json:"base64"`
	CapturedBytes int    `json:"capturedBytes"`
	TotalBytes    int64  `json:"totalBytes"`
	Truncated     bool   `json:"truncated"`
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }
func (values *stringList) Set(value string) error {
	if value != "" {
		*values = append(*values, value)
	}
	return nil
}

type frame struct {
	Pod          string       `json:"pod"`
	TimeEpoch    float64      `json:"timeEpoch,omitempty"`
	Source       string       `json:"source"`
	Destination  string       `json:"destination"`
	TCPStream    int          `json:"tcpStream"`
	Kind         string       `json:"kind"`
	Method       string       `json:"method,omitempty"`
	Host         string       `json:"host,omitempty"`
	Path         string       `json:"path,omitempty"`
	Status       int          `json:"status,omitempty"`
	HTTPVersion  string       `json:"httpVersion,omitempty"`
	ReasonPhrase string       `json:"reasonPhrase,omitempty"`
	Headers      []httpHeader `json:"headers"`
	Body         *httpBody    `json:"body,omitempty"`
	MatchedIDs   []string     `json:"matchedIds"`
	Raw          string       `json:"raw"`
}

type captureContext struct{ info gopacket.CaptureInfo }

func (context *captureContext) GetCaptureInfo() gopacket.CaptureInfo { return context.info }

type streamFactory struct {
	pod         string
	identifiers []string
	encoder     *json.Encoder
	streamIDs   map[string]int
	nextID      int
}

func connectionKey(network, transport gopacket.Flow) string {
	left := endpoint(network.Src().String(), transport.Src().String())
	right := endpoint(network.Dst().String(), transport.Dst().String())
	ends := []string{left, right}
	sort.Strings(ends)
	return strings.Join(ends, "<->")
}

func (factory *streamFactory) ensureStreamID(network, transport gopacket.Flow) int {
	key := connectionKey(network, transport)
	if id, ok := factory.streamIDs[key]; ok {
		return id
	}
	id := factory.nextID
	factory.nextID++
	factory.streamIDs[key] = id
	return id
}

func (factory *streamFactory) New(
	network, transport gopacket.Flow,
	_ *layers.TCP,
	_ reassembly.AssemblerContext,
) reassembly.Stream {
	return &tcpStream{
		factory:   factory,
		id:        factory.ensureStreamID(network, transport),
		network:   network,
		transport: transport,
	}
}

func (factory *streamFactory) emit(value frame) {
	if err := factory.encoder.Encode(value); err != nil {
		fmt.Fprintf(os.Stderr, "encode event: %v\n", err)
	}
}

type tcpStream struct {
	factory    *streamFactory
	id         int
	network    gopacket.Flow
	transport  gopacket.Flow
	directions [2]httpDirectionState
}

type httpBodyMode uint8

const (
	bodyHeader httpBodyMode = iota
	bodyFixed
	bodyChunked
	bodyUntilClose
)

type httpDirectionState struct {
	buffer         []byte
	mode           httpBodyMode
	remaining      int64
	chunkRemaining int64
	chunkTrailers  bool
	bodyFrame      *frame
	body           []byte
	bodyTotal      int64
	bodyExpected   int64
}

type parsedHTTPHeader struct {
	frame     frame
	bodyMode  httpBodyMode
	bodyBytes int64
}

func (*tcpStream) Accept(
	_ *layers.TCP,
	_ gopacket.CaptureInfo,
	_ reassembly.TCPFlowDirection,
	_ reassembly.Sequence,
	_ *bool,
	_ reassembly.AssemblerContext,
) bool {
	return true
}

func directionIndex(direction reassembly.TCPFlowDirection) int {
	if direction == reassembly.TCPDirServerToClient {
		return 1
	}
	return 0
}

func (stream *tcpStream) endpoints(direction reassembly.TCPFlowDirection) (string, string) {
	if direction == reassembly.TCPDirServerToClient {
		return endpoint(stream.network.Dst().String(), stream.transport.Dst().String()),
			endpoint(stream.network.Src().String(), stream.transport.Src().String())
	}
	return endpoint(stream.network.Src().String(), stream.transport.Src().String()),
		endpoint(stream.network.Dst().String(), stream.transport.Dst().String())
}

func (stream *tcpStream) ReassembledSG(scatter reassembly.ScatterGather, context reassembly.AssemblerContext) {
	direction, _, _, skipped := scatter.Info()
	length, _ := scatter.Lengths()
	if length == 0 || skipped > 0 {
		return
	}
	state := &stream.directions[directionIndex(direction)]
	state.buffer = append(state.buffer, scatter.Fetch(length)...)
	stream.consumeHTTP(state, direction, context.GetCaptureInfo().Timestamp)
}

func (stream *tcpStream) ReassemblyComplete(reassembly.AssemblerContext) bool {
	for index := range stream.directions {
		state := &stream.directions[index]
		if state.bodyFrame != nil {
			// Reassembly can end because the capture window stopped, so an unterminated body is only partial evidence.
			stream.emitBody(state, true)
		}
	}
	return true
}

func (stream *tcpStream) consumeHTTP(
	state *httpDirectionState,
	direction reassembly.TCPFlowDirection,
	seenAt time.Time,
) {
	for {
		if !stream.consumeHTTPBody(state) {
			return
		}

		start := findHTTPStart(state.buffer)
		if start < 0 {
			if len(state.buffer) > maxHTTPHeaderBytes {
				state.buffer = append([]byte(nil), state.buffer[len(state.buffer)-32:]...)
			}
			return
		}
		if start > 0 {
			state.buffer = state.buffer[start:]
		}
		headerEnd := bytes.Index(state.buffer, []byte("\r\n\r\n"))
		if headerEnd < 0 {
			if len(state.buffer) > maxHTTPHeaderBytes {
				state.buffer = state.buffer[1:]
				continue
			}
			return
		}
		headerBytes := state.buffer[:headerEnd+4]
		parsed, ok := parseHTTPHeader(string(headerBytes))
		if !ok {
			state.buffer = state.buffer[1:]
			continue
		}
		value := parsed.frame
		source, destination := stream.endpoints(direction)
		value.Pod = stream.factory.pod
		value.TimeEpoch = epoch(seenAt)
		value.Source = source
		value.Destination = destination
		value.TCPStream = stream.id
		value.MatchedIDs = matchedIdentifiers(string(headerBytes), stream.factory.identifiers)
		value.Raw = string(headerBytes)
		stream.factory.emit(value)
		state.buffer = state.buffer[headerEnd+4:]
		state.mode = parsed.bodyMode
		state.remaining = parsed.bodyBytes
		if state.mode != bodyHeader {
			bodyValue := value
			bodyValue.Kind = "body"
			bodyValue.Raw = "HTTP body"
			bodyValue.Body = nil
			state.bodyFrame = &bodyValue
			state.body = nil
			state.bodyTotal = 0
			state.bodyExpected = parsed.bodyBytes
		}
		if state.mode == bodyChunked {
			state.chunkRemaining = -1
			state.chunkTrailers = false
		}
	}
}

func (stream *tcpStream) appendBody(state *httpDirectionState, value []byte) {
	state.bodyTotal += int64(len(value))
	remaining := maxHTTPBodyCaptureBytes - len(state.body)
	if remaining > 0 {
		state.body = append(state.body, value[:min(remaining, len(value))]...)
	}
}

func (stream *tcpStream) emitBody(state *httpDirectionState, incomplete bool) {
	if state.bodyFrame == nil {
		return
	}
	total := state.bodyTotal
	if state.bodyExpected > total {
		total = state.bodyExpected
	}
	value := *state.bodyFrame
	value.Body = &httpBody{
		Base64:        base64.StdEncoding.EncodeToString(state.body),
		CapturedBytes: len(state.body),
		TotalBytes:    total,
		Truncated:     incomplete || int64(len(state.body)) < total,
	}
	stream.factory.emit(value)
	state.bodyFrame = nil
	state.body = nil
	state.bodyTotal = 0
	state.bodyExpected = 0
}

func (stream *tcpStream) consumeHTTPBody(state *httpDirectionState) bool {
	switch state.mode {
	case bodyHeader:
		return true
	case bodyFixed:
		if int64(len(state.buffer)) < state.remaining {
			stream.appendBody(state, state.buffer)
			state.remaining -= int64(len(state.buffer))
			state.buffer = nil
			return false
		}
		stream.appendBody(state, state.buffer[:state.remaining])
		state.buffer = state.buffer[state.remaining:]
		state.remaining = 0
		state.mode = bodyHeader
		stream.emitBody(state, false)
		return true
	case bodyChunked:
		return stream.consumeChunkedBody(state)
	case bodyUntilClose:
		stream.appendBody(state, state.buffer)
		state.buffer = nil
		return false
	default:
		return false
	}
}

func findHTTPStart(value []byte) int {
	text := string(value)
	prefixes := []string{
		"HTTP/1.", "GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "HEAD ",
		"OPTIONS ", "CONNECT ", "TRACE ",
	}
	best := -1
	for _, prefix := range prefixes {
		searchFrom := 0
		for {
			found := strings.Index(text[searchFrom:], prefix)
			if found < 0 {
				break
			}
			position := searchFrom + found
			if position == 0 || (position >= 2 && text[position-2:position] == "\r\n") {
				if best < 0 || position < best {
					best = position
				}
				break
			}
			searchFrom = position + 1
		}
	}
	return best
}

func (stream *tcpStream) consumeChunkedBody(state *httpDirectionState) bool {
	for {
		if state.chunkTrailers {
			lineEnd := bytes.Index(state.buffer, []byte("\r\n"))
			if lineEnd < 0 {
				return false
			}
			state.buffer = state.buffer[lineEnd+2:]
			if lineEnd == 0 {
				state.chunkTrailers = false
				state.mode = bodyHeader
				stream.emitBody(state, false)
				return true
			}
			continue
		}
		if state.chunkRemaining < 0 {
			lineEnd := bytes.Index(state.buffer, []byte("\r\n"))
			if lineEnd < 0 {
				return false
			}
			sizeText := string(state.buffer[:lineEnd])
			if before, _, found := strings.Cut(sizeText, ";"); found {
				sizeText = before
			}
			size, err := strconv.ParseInt(strings.TrimSpace(sizeText), 16, 64)
			if err != nil || size < 0 {
				state.mode = bodyUntilClose
				state.buffer = nil
				return false
			}
			state.buffer = state.buffer[lineEnd+2:]
			if size == 0 {
				state.chunkTrailers = true
				continue
			}
			state.chunkRemaining = size
		}
		if int64(len(state.buffer)) < state.chunkRemaining {
			stream.appendBody(state, state.buffer)
			state.chunkRemaining -= int64(len(state.buffer))
			state.buffer = nil
			return false
		}
		stream.appendBody(state, state.buffer[:state.chunkRemaining])
		state.buffer = state.buffer[state.chunkRemaining:]
		state.chunkRemaining = 0
		if len(state.buffer) < 2 {
			return false
		}
		if string(state.buffer[:2]) != "\r\n" {
			state.mode = bodyUntilClose
			state.buffer = nil
			return false
		}
		state.buffer = state.buffer[2:]
		state.chunkRemaining = -1
	}
}

func parseHTTPHeader(header string) (parsedHTTPHeader, bool) {
	lines := strings.Split(header, "\r\n")
	if len(lines) == 0 {
		return parsedHTTPHeader{}, false
	}
	first := strings.Fields(lines[0])
	value := frame{MatchedIDs: []string{}, Headers: []httpHeader{}}
	request := false
	if len(first) >= 3 && strings.HasPrefix(first[2], "HTTP/") {
		value.Kind = "request"
		value.Method = first[0]
		value.Path = first[1]
		value.HTTPVersion = first[2]
		request = true
	} else if len(first) >= 2 && strings.HasPrefix(first[0], "HTTP/") {
		status, err := strconv.Atoi(first[1])
		if err != nil {
			return parsedHTTPHeader{}, false
		}
		value.Kind = "response"
		value.Status = status
		value.HTTPVersion = first[0]
		if len(first) > 2 {
			value.ReasonPhrase = strings.Join(first[2:], " ")
		}
	} else {
		return parsedHTTPHeader{}, false
	}
	bodyMode := bodyHeader
	var bodyBytes int64
	hasContentLength := false
	for _, line := range lines[1:] {
		name, content, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		name = strings.TrimSpace(name)
		content = strings.TrimSpace(content)
		value.Headers = append(value.Headers, httpHeader{Name: name, Value: content})
		switch {
		case strings.EqualFold(name, "host"):
			value.Host = content
		case strings.EqualFold(name, "transfer-encoding") && strings.Contains(strings.ToLower(content), "chunked"):
			bodyMode = bodyChunked
		case strings.EqualFold(name, "content-length") && bodyMode != bodyChunked:
			hasContentLength = true
			length, err := strconv.ParseInt(content, 10, 64)
			if err != nil || length < 0 {
				return parsedHTTPHeader{}, false
			}
			if length > 0 {
				bodyMode = bodyFixed
				bodyBytes = length
			}
		}
	}
	if !request && !hasContentLength && bodyMode == bodyHeader &&
		!(value.Status >= 100 && value.Status < 200) && value.Status != 204 && value.Status != 304 {
		bodyMode = bodyUntilClose
	}
	return parsedHTTPHeader{frame: value, bodyMode: bodyMode, bodyBytes: bodyBytes}, true
}

func matchedIdentifiers(raw string, identifiers []string) []string {
	matched := make([]string, 0, len(identifiers))
	for _, identifier := range identifiers {
		if strings.Contains(raw, identifier) {
			matched = append(matched, identifier)
		}
	}
	return matched
}

func endpoint(address, port string) string {
	if strings.Contains(address, ":") && !strings.HasPrefix(address, "[") {
		return "[" + address + "]:" + port
	}
	return address + ":" + port
}

func epoch(value time.Time) float64 {
	return float64(value.UnixNano()) / float64(time.Second)
}

func packetEndpoints(network gopacket.NetworkLayer, tcp *layers.TCP) (string, string) {
	flow := network.NetworkFlow()
	return endpoint(flow.Src().String(), tcp.SrcPort.String()), endpoint(flow.Dst().String(), tcp.DstPort.String())
}

func emitPacketSignals(
	factory *streamFactory,
	network gopacket.NetworkLayer,
	tcp *layers.TCP,
	seenAt time.Time,
) {
	flow := network.NetworkFlow()
	id := factory.ensureStreamID(flow, tcp.TransportFlow())
	source, destination := packetEndpoints(network, tcp)
	value := frame{
		Pod: factory.pod, TimeEpoch: epoch(seenAt), Source: source, Destination: destination,
		TCPStream: id, MatchedIDs: []string{},
	}
	if tcp.RST {
		value.Kind = "reset"
		value.Raw = "TCP RST"
		factory.emit(value)
	}
	if tcp.FIN {
		value.Kind = "finish"
		value.Raw = "TCP FIN"
		factory.emit(value)
	}
	if len(tcp.Payload) >= 3 && tcp.Payload[0] == 0x16 && tcp.Payload[1] == 0x03 {
		value.Kind = "tls"
		value.Raw = fmt.Sprintf("TLS handshake record version=3.%d", tcp.Payload[2])
		if len(tcp.Payload) >= 6 {
			value.Raw += fmt.Sprintf(" handshake_type=%d", tcp.Payload[5])
		}
		factory.emit(value)
	}
}

func decode(path, pod string, identifiers []string, output io.Writer) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open pcap: %w", err)
	}
	defer file.Close()
	reader, err := pcapgo.NewReader(bufio.NewReader(file))
	if err != nil {
		return fmt.Errorf("read pcap header: %w", err)
	}
	factory := &streamFactory{
		pod: pod, identifiers: identifiers, encoder: json.NewEncoder(output), streamIDs: map[string]int{},
	}
	assembler := reassembly.NewAssembler(reassembly.NewStreamPool(factory))
	for {
		data, captureInfo, readErr := reader.ZeroCopyReadPacketData()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read packet: %w", readErr)
		}
		packet := gopacket.NewPacket(data, reader.LinkType(), gopacket.DecodeOptions{Lazy: true, NoCopy: true})
		network := packet.NetworkLayer()
		tcpLayer := packet.Layer(layers.LayerTypeTCP)
		if network == nil || tcpLayer == nil {
			continue
		}
		tcp, ok := tcpLayer.(*layers.TCP)
		if !ok {
			continue
		}
		context := &captureContext{info: captureInfo}
		factory.ensureStreamID(network.NetworkFlow(), tcp.TransportFlow())
		assembler.AssembleWithContext(network.NetworkFlow(), tcp, context)
		emitPacketSignals(factory, network, tcp, captureInfo.Timestamp)
	}
	assembler.FlushAll()
	return nil
}

func runDecode(args []string) error {
	flags := flag.NewFlagSet("decode", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	input := flags.String("input", "", "pcap input path")
	pod := flags.String("pod", "", "pod label for emitted events")
	var identifiers stringList
	flags.Var(&identifiers, "identifier", "capture or trace identifier; repeatable")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" || *pod == "" {
		return errors.New("decode requires --input and --pod")
	}
	return decode(*input, *pod, identifiers, os.Stdout)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "decode" {
		fmt.Fprintln(os.Stderr, "usage: doctor-pcap decode --input <capture.pcap> --pod <pod> [--identifier <id>]")
		os.Exit(2)
	}
	if err := runDecode(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
