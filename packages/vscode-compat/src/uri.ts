/** VSCode-compatible Uri implementation */
export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  /** File system path (decoded, platform-specific) */
  get fsPath(): string {
    return this.path;
  }

  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(
        url.protocol.replace(":", ""),
        url.host,
        decodeURIComponent(url.pathname),
        url.search.replace("?", ""),
        url.hash.replace("#", ""),
      );
    } catch {
      // Treat as file path if not a valid URL
      return Uri.file(value);
    }
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    if (this.scheme === "file") return `file://${this.path}`;
    let result = `${this.scheme}://`;
    if (this.authority) result += this.authority;
    result += this.path;
    if (this.query) result += `?${this.query}`;
    if (this.fragment) result += `#${this.fragment}`;
    return result;
  }

  toJSON(): { scheme: string; authority: string; path: string; query: string; fragment: string } {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}
