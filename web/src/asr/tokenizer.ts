const BYTE_PIECE = /^<0x([0-9A-Fa-f]{2})>$/;

/** SentencePiece decoding (`▁` to space, `<0xNN>` byte fallback), trimmed like haas_ja_local's `transcribe`. */
export class PieceDecoder {
  readonly #bytes: readonly Uint8Array[];

  constructor(pieces: readonly string[]) {
    const enc = new TextEncoder();
    this.#bytes = pieces.map((p) => {
      const m = BYTE_PIECE.exec(p);
      return m?.[1] !== undefined ? Uint8Array.of(parseInt(m[1], 16)) : enc.encode(p.replaceAll("▁", " "));
    });
  }

  decode(ids: readonly number[]): string {
    let n = 0;
    for (const id of ids) n += this.#piece(id).length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const id of ids) {
      const b = this.#piece(id);
      out.set(b, at);
      at += b.length;
    }
    return new TextDecoder().decode(out).trim();
  }

  #piece(id: number): Uint8Array {
    const b = this.#bytes[id];
    if (b === undefined) throw new Error(`token id ${id} is outside the ${this.#bytes.length}-piece vocabulary`);
    return b;
  }
}

/** Parses the untrusted `pieces.json` (an array of piece strings). */
export function parsePieces(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) throw new Error("pieces.json must be an array of strings");
  return raw as string[];
}
