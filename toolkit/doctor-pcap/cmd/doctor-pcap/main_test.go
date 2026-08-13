package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"
	"github.com/gopacket/gopacket/pcapgo"
)

func writeTCPPacket(
	t *testing.T,
	writer *pcapgo.Writer,
	seenAt time.Time,
	sourceIP, destinationIP net.IP,
	sourcePort, destinationPort layers.TCPPort,
	sequence, acknowledgement uint32,
	syn, ack, rst bool,
	payload []byte,
) {
	t.Helper()
	ethernet := &layers.Ethernet{
		SrcMAC:       net.HardwareAddr{0, 1, 2, 3, 4, 5},
		DstMAC:       net.HardwareAddr{6, 7, 8, 9, 10, 11},
		EthernetType: layers.EthernetTypeIPv4,
	}
	ip := &layers.IPv4{Version: 4, TTL: 64, SrcIP: sourceIP, DstIP: destinationIP, Protocol: layers.IPProtocolTCP}
	tcp := &layers.TCP{
		SrcPort: sourcePort, DstPort: destinationPort, Seq: sequence, Ack: acknowledgement,
		SYN: syn, ACK: ack, RST: rst, Window: 65535,
	}
	if err := tcp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}
	buffer := gopacket.NewSerializeBuffer()
	if err := gopacket.SerializeLayers(
		buffer,
		gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true},
		ethernet,
		ip,
		tcp,
		gopacket.Payload(payload),
	); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	if err := writer.WritePacket(gopacket.CaptureInfo{
		Timestamp: seenAt, CaptureLength: len(data), Length: len(data),
	}, data); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeReassemblesHTTPAndKeepsResetSeparateFrom499(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "capture.pcap")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := pcapgo.NewWriter(file)
	if err := writer.WriteFileHeader(65535, layers.LinkTypeEthernet); err != nil {
		t.Fatal(err)
	}
	client := net.IPv4(10, 0, 0, 1)
	server := net.IPv4(10, 0, 0, 2)
	started := time.Unix(1, 0)
	writeTCPPacket(t, writer, started, client, server, 12345, 8000, 100, 0, true, false, false, nil)
	writeTCPPacket(t, writer, started.Add(time.Millisecond), server, client, 8000, 12345, 500, 101, true, true, false, nil)
	writeTCPPacket(t, writer, started.Add(2*time.Millisecond), client, server, 12345, 8000, 101, 501, false, true, false, nil)
	firstRequest := []byte("GET /health HTTP/1.1\r\nHost: frontend\r\nContent-Length: 0\r\n\r\n")
	writeTCPPacket(t, writer, started.Add(3*time.Millisecond), client, server, 12345, 8000, 101, 501, false, true, false, firstRequest)
	firstResponse := []byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	writeTCPPacket(t, writer, started.Add(4*time.Millisecond), server, client, 8000, 12345, 501, uint32(101+len(firstRequest)), false, true, false, firstResponse)
	requestBody := []byte(`{"hello":"world"}`)
	request := append(
		[]byte("POST /api/chat HTTP/1.1\r\nHost: frontend\r\nX-Doctor-Capture-ID: doctor-test\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n"),
		requestBody...,
	)
	cut := len(request) / 2
	clientSequence := uint32(101 + len(firstRequest))
	serverSequence := uint32(501 + len(firstResponse))
	writeTCPPacket(t, writer, started.Add(5*time.Millisecond), client, server, 12345, 8000, clientSequence, serverSequence, false, true, false, request[:cut])
	writeTCPPacket(t, writer, started.Add(6*time.Millisecond), client, server, 12345, 8000, clientSequence+uint32(cut), serverSequence, false, true, false, request[cut:])
	response := []byte("HTTP/1.1 499 Client Closed Request\r\nContent-Length: 0\r\n\r\n")
	writeTCPPacket(t, writer, started.Add(7*time.Millisecond), server, client, 8000, 12345, serverSequence, clientSequence+uint32(len(request)), false, true, false, response)
	writeTCPPacket(t, writer, started.Add(8*time.Millisecond), client, server, 12345, 8000, clientSequence+uint32(len(request)), serverSequence+uint32(len(response)), false, true, true, nil)
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := decode(path, "chat-0", []string{"doctor-test"}, &output); err != nil {
		t.Fatal(err)
	}
	var events []frame
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n")) {
		var value frame
		if err := json.Unmarshal(line, &value); err != nil {
			t.Fatal(err)
		}
		events = append(events, value)
	}
	if len(events) != 7 {
		t.Fatalf("expected two request/response pairs, two bodies and reset; got %#v", events)
	}
	if events[2].Kind != "body" || events[2].Body == nil || events[2].Body.TotalBytes != 2 {
		t.Fatalf("unexpected first response body: %#v", events[2])
	}
	if events[3].Kind != "request" || events[3].Method != "POST" || len(events[3].MatchedIDs) != 1 {
		t.Fatalf("unexpected dyed request: %#v", events[3])
	}
	if events[4].Kind != "body" || events[4].Body == nil {
		t.Fatalf("unexpected request body: %#v", events[4])
	}
	decodedRequestBody, err := base64.StdEncoding.DecodeString(events[4].Body.Base64)
	if err != nil || !bytes.Equal(decodedRequestBody, requestBody) || events[4].Body.Truncated {
		t.Fatalf("unexpected request body capture: %#v", events[4].Body)
	}
	if events[5].Kind != "response" || events[5].Status != 499 {
		t.Fatalf("unexpected response: %#v", events[5])
	}
	if events[6].Kind != "reset" {
		t.Fatalf("unexpected final event: %#v", events[6])
	}
}

func TestConsumeChunkedBodyAdvancesToNextMessageWithoutBufferingWholeBody(t *testing.T) {
	stream := &tcpStream{}
	state := httpDirectionState{
		mode: bodyChunked, chunkRemaining: -1, buffer: []byte("4\r\nWi"),
	}
	if stream.consumeChunkedBody(&state) {
		t.Fatal("partial chunk must wait for more bytes")
	}
	if state.chunkRemaining != 2 || len(state.buffer) != 0 {
		t.Fatalf("partial chunk was not consumed incrementally: %#v", state)
	}
	state.buffer = append(state.buffer, []byte("ki\r\n0\r\n\r\nPOST /next HTTP/1.1\r\n")...)
	if !stream.consumeChunkedBody(&state) {
		t.Fatal("complete chunked body must return to header mode")
	}
	if state.mode != bodyHeader || string(state.buffer) != "POST /next HTTP/1.1\r\n" {
		t.Fatalf("next message was not preserved: %#v", state)
	}
}
