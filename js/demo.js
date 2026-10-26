/* yt-bulk-edits :: demo.js — offline sample channel.
 *
 * Lets the whole pipeline be exercised (and unit-tested) with no credentials.
 * Deliberately includes edge cases: a title already at the 100-char limit, a
 * video with no tags, unicode text, a near-500-char tag list, and duplicates.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};

  var CHANNEL = {
    id: 'UCdemoChannel0000000000000000',
    title: 'Demo Channel (offline sample data)',
    description: 'Sample data for trying the tool without connecting a real account.',
    thumbnail: null,
    country: 'US',
    uploadsPlaylist: 'UUdemoChannel0000000000000000',
    videoCount: 12,
    viewCount: 128340,
    subscriberCount: 1520,
    demo: true
  };

  function vid(id, title, description, tags, categoryId, publishedAt, privacy, views, duration) {
    return {
      id: id,
      snippet: {
        title: title,
        description: description,
        tags: tags || [],
        categoryId: String(categoryId || '28'),
        channelTitle: CHANNEL.title,
        publishedAt: publishedAt,
        defaultLanguage: '',
        defaultAudioLanguage: '',
        localized: null,
        thumbnails: null
      },
      status: { privacyStatus: privacy || 'public', selfDeclaredMadeForKids: false, embeddable: true, publicStatsViewable: true },
      contentDetails: { duration: duration || 'PT10M30S' },
      statistics: { viewCount: String(views == null ? 100 : views), likeCount: '10', commentCount: '2' }
    };
  }

  function sampleVideos() {
    return [
      vid('DEMO0001aaa', '[2024 REMASTER] Building a Game Engine - Part 1 | FULL COURSE', 'Welcome back to the channel!\n\nIn this episode we build the renderer.\n\n#gameengine #coding\n\nBuy merch: https://example.shop/merch\nPatreon: https://patreon.com/example', ['game engine', 'coding tutorial', '2024 remaster', 'c++'], '28', '2024-03-11T15:00:00Z', 'public', 48210, 'PT42M11S'),
      vid('DEMO0002bbb', '[2024 REMASTER] Building a Game Engine - Part 2 | FULL COURSE', 'Part two: the physics loop.\n\nBuy merch: https://example.shop/merch', ['game engine', 'physics', '2024 remaster'], '28', '2024-03-18T15:00:00Z', 'public', 31902),
      vid('DEMO0003ccc', '[2024 REMASTER] Building a Game Engine - Part 3 | FULL COURSE', 'Part three: audio mixing.\n\nBuy merch: https://example.shop/merch', ['game engine', 'audio', '2024 remaster'], '28', '2024-03-25T15:00:00Z', 'public', 27433),
      vid('DEMO0004ddd', 'Why I switched to Linux (and switched back)', 'A honest retrospective. Timestamps below.\n\n0:00 Intro\n3:12 The honeymoon', ['linux', 'retrospective', 'opinion'], '28', '2023-11-02T18:00:00Z', 'public', 15820),
      vid('DEMO0005eee', '10 VS Code extensions you actually need', 'Number 7 will surprise you.', ['vscode', 'productivity', 'extensions'], '28', '2025-01-19T12:00:00Z', 'public', 9310),
      vid('DEMO0006fff', 'Unlisted experiment: raw capture test', 'Internal test footage, do not index.', [], '22', '2025-06-04T09:30:00Z', 'unlisted', 12),
      vid('DEMO0007ggg', 'Private draft — Q3 planning notes', 'Draft only.', ['internal'], '22', '2025-09-30T20:00:00Z', 'private', 0),
      vid('DEMO0008hhh', 'Настройка локальной среды разработки — Полный гайд 2024', 'Полный гайд по настройке. Ссылки ниже.', ['русский', 'гайд', '2024'], '28', '2024-08-08T10:00:00Z', 'public', 4211),
      vid('DEMO0009iii', 'This title is deliberately close to the one hundred character limit that YouTube enforces on titles', 'The apply step must block this row if the replacement makes it longer than 100 characters.', ['limits', 'edge case'], '28', '2024-12-01T10:00:00Z', 'public', 883),
      vid('DEMO0010jjj', 'Shorts: quick tip #shorts', 'Vertical quick tip.', ['shorts', 'quick tip'], '28', '2025-04-22T08:00:00Z', 'public', 22014),
      vid('DEMO0011kkk', 'Building a game engine — the music behind the code', 'Composer interview.\n\nBuy merch: https://example.shop/merch', ['music', 'interview', 'game engine', 'lofi', 'soundtrack', 'behind the scenes', 'composer', 'indie', 'orchestral', 'synthwave', 'chiptune', 'ambient', 'jazz fusion', 'progressive rock', 'electronic', 'classical crossover', 'film score', 'video game music', '8-bit', '16-bit', 'remix', 'cover', 'live performance', 'studio session', 'mixing', 'mastering', 'daw', 'ableton', 'fl studio', 'logic pro'], '28', '2025-02-14T17:00:00Z', 'public', 6120),
      vid('DEMO0012lll', 'Building a Game Engine - Part 1 | FULL COURSE', 'Deliberate near-duplicate of DEMO0001aaa to exercise duplicate-title warnings.', ['game engine', 'duplicate'], '28', '2024-03-11T16:00:00Z', 'public', 1204)
    ];
  }

  function loadDemo() {
    YTBE.store.state.videos = sampleVideos();
    YTBE.store.state.videosLoadedAt = new Date().toISOString();
    YTBE.store.state.channel = Object.assign({}, CHANNEL);
    YTBE.store.state.demo = true;
    YTBE.store.state.selection = {};
    YTBE.store.emit('videos', { count: YTBE.store.state.videos.length, demo: true });
    return YTBE.store.state.videos;
  }

  YTBE.demo = { CHANNEL: CHANNEL, sampleVideos: sampleVideos, loadDemo: loadDemo };
})(typeof window !== 'undefined' ? window : globalThis);
