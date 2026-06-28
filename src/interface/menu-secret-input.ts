import type { OutputSink } from './render.js';

export async function readSecretLine(input: {
  out: OutputSink;
  readLine: () => Promise<string | null>;
  setEchoMuted?: (muted: boolean) => void;
  prompt: string;
}): Promise<string | null> {
  input.out.write(input.prompt);
  input.out.flush?.();
  if (input.setEchoMuted) {
    input.setEchoMuted(true);
  }
  try {
    const line = await input.readLine();
    if (line === null) return null;
    return line.trim();
  } finally {
    if (input.setEchoMuted) {
      input.setEchoMuted(false);
    }
    input.out.write('\n');
  }
}
