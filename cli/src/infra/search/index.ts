export type SearchQuery = Record<string, unknown>;
export type SearchResult = Record<string, unknown>;

/** Engine-neutral operations used by collect domains. */
export interface SearchEngine {
  count(index: string, query: SearchQuery): Promise<number>;
  search(index: string, body: SearchQuery): Promise<SearchResult>;
  close?(): Promise<void>;
}
