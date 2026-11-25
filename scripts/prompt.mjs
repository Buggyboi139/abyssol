// Asking for a line at the terminal, shown or hidden, for the sign-in scripts.
// Prompts go to standard error, so standard output holds only the result.

/** Everything piped in, when the script is not at a terminal. */
export async function readPiped() {
  let s = ''; for await (const c of process.stdin) s += c;
  return s.replace(/\r?\n$/, '');
}

/** One typed line. With `hidden`, the characters are not shown. */
export function askLine(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin, out = process.stderr;
    let line = '';
    out.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); out.write('\n'); resolve(line); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') { stdin.setRawMode(false); out.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (line) { line = line.slice(0, -1); if (!hidden) out.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        line += ch;
        if (!hidden) out.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

/** A password typed twice, not shown; exits if the two differ. */
export async function askPasswordTwice() {
  const a = await askLine('Password: ', { hidden: true });
  const b = await askLine('Password again: ', { hidden: true });
  if (a !== b) { console.error('The two did not match.'); process.exit(1); }
  return a;
}
