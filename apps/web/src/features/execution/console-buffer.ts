export type Stream = 'stdout' | 'stderr';
export interface ConsoleLine {
  readonly id: number;
  readonly stream: Stream;
  readonly text: string;
}
type EscapeState = 'text' | 'escape' | 'csi' | 'osc' | 'osc_escape';
/** Constant-space control-sequence decoder. Learner output is never interpreted as markup. */
class PlainText {
  private state: EscapeState = 'text';
  decode(text: string): string {
    let plain = '';
    for (const char of text) {
      if (this.state === 'escape') {
        this.state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text';
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') this.state = 'text';
      } else if (this.state === 'osc') {
        if (char === '\x07') this.state = 'text';
        else if (char === '\x1b') this.state = 'osc_escape';
      } else if (this.state === 'osc_escape') {
        this.state =
          char === '\\' ? 'text' : char === '\x1b' ? 'osc_escape' : 'osc';
      } else if (char === '\x1b') this.state = 'escape';
      else if (
        char === '\n' ||
        char === '\t' ||
        (char >= ' ' && char !== '\x7f' && !(char >= '\x80' && char <= '\x9f'))
      )
        plain += char;
    }
    return plain;
  }
}
export const CONSOLE_LIMITS = Object.freeze({
  lines: 5000,
  lineCharacters: 8192,
  pageLines: 200,
});
export class ConsoleBuffer {
  private lines: { id: number; stream: Stream; text: string }[] = [];
  private ended = true;
  private nextId = 0;
  private readonly decoders = {
    stdout: new PlainText(),
    stderr: new PlainText(),
  };
  append(stream: Stream, text: string): boolean {
    for (const char of this.decoders[stream].decode(text)) {
      let line = this.lines.at(-1);
      if (
        this.ended ||
        !line ||
        line.stream !== stream ||
        line.text.length + char.length > CONSOLE_LIMITS.lineCharacters
      ) {
        if (this.lines.length >= CONSOLE_LIMITS.lines) return false;
        line = { id: this.nextId++, stream, text: '' };
        this.lines.push(line);
        this.ended = false;
      }
      if (char === '\n') this.ended = true;
      else line.text += char;
    }
    return true;
  }
  snapshot(): readonly ConsoleLine[] {
    return Object.freeze(this.lines.map((line) => Object.freeze({ ...line })));
  }
  clear(): void {
    this.lines = [];
    this.ended = true;
  }
}
