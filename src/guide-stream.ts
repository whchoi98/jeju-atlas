// Matches the server's maximum serialized SSE frame, including its separator.
// Measure frames rather than transport chunks: a chunk can contain many events.
const FRAME_LIMIT = 512 * 1024;

export function splitGuideFrames(input: string): { frames: string[]; rest: string } | null {
  const frames: string[] = [];
  let rest = input;
  let boundary: RegExpExecArray | null;
  while ((boundary = /\r?\n\r?\n/.exec(rest))) {
    const end = boundary.index + boundary[0].length;
    if (end > FRAME_LIMIT) return null;
    frames.push(rest.slice(0, boundary.index));
    rest = rest.slice(end);
  }
  return rest.length > FRAME_LIMIT ? null : { frames, rest };
}
