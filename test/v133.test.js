// 1.1.22: "his latest video" kept surfacing the channel's LIVESTREAMS (FLS's screenshot: the assistant
// apologised — search "defaults to showing his recent livestreams first, and it doesn't have a simple
// filter to exclude livestreams"). The results page itself marks them: a LIVE badge for live-now, a
// "Streamed …" published line for a past stream (usually a marathon). parseYoutubeSearch now captures
// live / streamed / age / duration-seconds, and rankYoutubeMatches puts a regular video first — a
// stream only wins when the ask was for a live/long one, and "latest" breaks ties by age.
import { setupEnv } from './helpers.js';
setupEnv('v133', {});
import test from 'node:test';
import assert from 'node:assert/strict';
const media = await import('../src/tools/media.js');

// YouTube's own order (streams pinned on top, the newest regular video buried last):
const HTML = 'x'
  + '"videoRenderer":{"videoId":"LIVE0000001","thumbnail":{},"title":{"runs":[{"text":"Channel Name - Live Now"}]},"badges":[{"metadataBadgeRenderer":{"icon":{"iconType":"LIVE"},"label":"LIVE"}}],"viewCountText":{"simpleText":"1,204 watching"}'
  + ' y "videoRenderer":{"videoId":"STREAM00001","title":{"runs":[{"text":"Channel Name - Sunday Marathon Stream"}]},"publishedTimeText":{"simpleText":"Streamed 3 days ago"},"lengthText":{"simpleText":"5:12:09"}'
  + ' y "videoRenderer":{"videoId":"OLDER000001","title":{"runs":[{"text":"Channel Name - Older Video"}]},"publishedTimeText":{"simpleText":"2 weeks ago"},"lengthText":{"simpleText":"10:24"}'
  + ' y "videoRenderer":{"videoId":"FRESH000001","title":{"runs":[{"text":"Channel Name - New Short Video"}]},"publishedTimeText":{"simpleText":"3 hours ago"},"lengthText":{"simpleText":"0:58"}';

test('parse: live badge, "Streamed …" line, age and duration are captured', () => {
  const v = media.parseYoutubeSearch(HTML);
  assert.equal(v.length, 4);
  const [live, streamed, older, fresh] = v;
  assert.equal(live.live, true, 'the LIVE badge is seen');
  assert.equal(streamed.live, false);
  assert.equal(streamed.streamed, true, 'a "Streamed …" published line marks a past stream');
  assert.equal(streamed.duration_seconds, 5 * 3600 + 12 * 60 + 9, 'the marathon length is in seconds');
  assert.equal(streamed.age_seconds, 3 * 86400);
  assert.equal(older.age_seconds, 14 * 86400);
  assert.equal(fresh.age_seconds, 3 * 3600);
  assert.equal(fresh.duration_seconds, 58);
  assert.equal(fresh.streamed, false);
});

test('rank: a plain video ask puts regular videos first and the marathon stream last', () => {
  const v = media.parseYoutubeSearch(HTML);
  const ids = media.rankYoutubeMatches('Channel Name video', v).map(x => x.id);
  assert.deepEqual(ids, ['OLDER000001', 'FRESH000001', 'LIVE0000001', 'STREAM00001'], 'regular videos first, live next, the streamed marathon last: ' + ids.join(','));
});

test('rank: a "latest" ask lets the newest regular video win the tie', () => {
  const v = media.parseYoutubeSearch(HTML);
  const ids = media.rankYoutubeMatches('Channel Name latest video', v).map(x => x.id);
  assert.equal(ids[0], 'FRESH000001', 'the 3-hour-old short video is the latest regular one');
  assert.equal(ids[3], 'STREAM00001', 'the marathon stream still sinks');
});

test('rank: an ask FOR a live stream is not penalised', () => {
  const v = media.parseYoutubeSearch(HTML);
  const ids = media.rankYoutubeMatches('Channel Name live stream', v).map(x => x.id);
  assert.equal(ids[0], 'LIVE0000001', 'the live-now video leads a live ask');
  assert.equal(ids[1], 'STREAM00001', 'the stream recording is next, not sunk');
});
