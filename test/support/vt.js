// A small terminal for tests: enough of a VT to replay what the bridge
// sends a device (positioning, erases, line feeds that scroll into a
// scrollback, text) and to say what the screen and its history show.
// Colours and modes are read and ignored.

export class Terminal {
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.scrollback = [];
    this.screen = Array.from({ length: rows }, () => this.blank());
    this.row = 0;
    this.column = 0;
    this.pendingWrap = false;
    this.pending = "";
  }

  blank() {
    return Array(this.columns).fill(" ");
  }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => this.blank());
    this.row = Math.min(this.row, rows - 1);
    this.column = Math.min(this.column, columns - 1);
  }

  lineFeed() {
    if (this.row === this.rows - 1) {
      this.scrollback.push(this.screen.shift().join("").trimEnd());
      this.screen.push(this.blank());
    } else {
      this.row += 1;
    }
  }

  write(input) {
    const text = this.pending + (Buffer.isBuffer(input) ? input.toString("utf8") : input);
    this.pending = "";
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (character === "\x1b") {
        const rest = text.slice(index);
        const csi = rest.match(/^\x1b\[([?!>]?)([\d;]*)([ -/]*)([@-~])/);
        const osc = rest.match(/^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/);
        if (csi) {
          this.csi(csi[1], csi[2], csi[4]);
          index += csi[0].length;
        } else if (osc) {
          index += osc[0].length;
        } else if (rest.length < 2 || (rest[1] === "[" && !/[@-~]/.test(rest.slice(2))) || (rest[1] === "]" && !/\x07|\x1b\\/.test(rest))) {
          this.pending = rest;
          return;
        } else {
          index += 2;
        }
        continue;
      }
      if (character === "\r") {
        this.column = 0;
        this.pendingWrap = false;
      } else if (character === "\n") {
        this.lineFeed();
        this.pendingWrap = false;
      } else if (character === "\b") {
        this.column = Math.max(0, this.column - 1);
      } else if (character >= " ") {
        if (this.pendingWrap) {
          this.column = 0;
          this.lineFeed();
          this.pendingWrap = false;
        }
        this.screen[this.row][this.column] = character;
        if (this.column === this.columns - 1) this.pendingWrap = true;
        else this.column += 1;
      }
      index += 1;
    }
  }

  csi(prefix, parameters, final) {
    const values = parameters.split(";").map((value) => (value === "" ? undefined : Number(value)));
    if (prefix) return;
    switch (final) {
      case "H":
      case "f":
        this.row = Math.min(this.rows, Math.max(1, values[0] ?? 1)) - 1;
        this.column = Math.min(this.columns, Math.max(1, values[1] ?? 1)) - 1;
        this.pendingWrap = false;
        break;
      case "J": {
        const mode = values[0] ?? 0;
        if (mode === 2) this.screen = Array.from({ length: this.rows }, () => this.blank());
        else if (mode === 3) this.scrollback = [];
        else if (mode === 0) {
          for (let column = this.column; column < this.columns; column++) this.screen[this.row][column] = " ";
          for (let row = this.row + 1; row < this.rows; row++) this.screen[row] = this.blank();
        }
        break;
      }
      case "K": {
        const mode = values[0] ?? 0;
        const [from, to] = mode === 1 ? [0, this.column + 1] : mode === 2 ? [0, this.columns] : [this.column, this.columns];
        for (let column = from; column < to; column++) this.screen[this.row][column] = " ";
        break;
      }
      case "A":
        this.row = Math.max(0, this.row - (values[0] ?? 1));
        break;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + (values[0] ?? 1));
        break;
      case "C":
        this.column = Math.min(this.columns - 1, this.column + (values[0] ?? 1));
        break;
      case "D":
        this.column = Math.max(0, this.column - (values[0] ?? 1));
        break;
      case "G":
        this.column = Math.min(this.columns, Math.max(1, values[0] ?? 1)) - 1;
        break;
      case "X":
        for (let column = this.column; column < Math.min(this.columns, this.column + (values[0] ?? 1)); column++) this.screen[this.row][column] = " ";
        break;
      default:
        break;
    }
  }

  screenLines() {
    return this.screen.map((line) => line.join("").trimEnd());
  }

  /// Scrollback and screen, trailing blank lines dropped.
  allLines() {
    const lines = [...this.scrollback, ...this.screenLines()];
    while (lines.length && lines.at(-1) === "") lines.pop();
    return lines;
  }
}
