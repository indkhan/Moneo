/** Local playback gate; the remote stream continues so its quiet boundary can release the mute. */
export class VoicePlayback {
  private duckUntil = 0;
  private stopped = false;
  private quietSince = 0;
  transcript(text: string) {
    if (this.duckUntil && /\p{L}/u.test(text) && !/^(mm[ -]?hm|mhm|yeah|okay)[.!?,\s]*$/i.test(text.trim())) this.stopped = true;
  }
  volume(now: number, mic: boolean, remote: boolean) {
    if (mic && remote) this.duckUntil = now + 1000;
    if (remote) this.quietSince = 0;
    else this.quietSince ||= now;
    if (this.quietSince && now - this.quietSince >= 500) { this.stopped = false; this.duckUntil = 0; }
    return this.stopped ? 0 : now < this.duckUntil ? 0.2 : 1;
  }
}
