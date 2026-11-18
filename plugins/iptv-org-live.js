// iptv-org 直播插件 · HGhub HPP protocol 1
// 数据源：iptv-org 开源维护的公开直播列表（https://iptv-org.github.io/iptv/）
// 纯直播源：只实现 live 能力，不伪造点播详情。
// 频道 id 为“分组:序号”，解析时按序号从分组播放列表里取流地址。

export const meta = {
  id: "iptv-org.live",
  name: "IPTV 直播",
  version: "1.0.0",
  protocol: 1,
  description: "iptv-org 公开直播源：按地区与分类浏览全球电视台，免费开源列表，信号源质量以各台实际为准。",
  author: "Muse",
  homepage: "https://iptv-org.github.io/",
  updateUrl: "https://raw.githubusercontent.com/Jimmy6188/HGhub/main/plugins/manifest.json",
  allowInsecureHttp: true,
  timeouts: { read: 25, playback: 20 },
};

const BASE = "https://iptv-org.github.io/iptv";

const GROUPS = [
  { id: "cn", label: "中国大陆", url: `${BASE}/countries/cn.m3u` },
  { id: "hk", label: "中国香港", url: `${BASE}/countries/hk.m3u` },
  { id: "tw", label: "中国台湾", url: `${BASE}/countries/tw.m3u` },
  { id: "us", label: "美国", url: `${BASE}/countries/us.m3u` },
  { id: "uk", label: "英国", url: `${BASE}/countries/uk.m3u` },
  { id: "jp", label: "日本", url: `${BASE}/countries/jp.m3u` },
  { id: "kr", label: "韩国", url: `${BASE}/countries/kr.m3u` },
  { id: "news", label: "新闻", url: `${BASE}/categories/news.m3u` },
  { id: "sports", label: "体育", url: `${BASE}/categories/sports.m3u` },
  { id: "movies", label: "电影", url: `${BASE}/categories/movies.m3u` },
  { id: "music", label: "音乐", url: `${BASE}/categories/music.m3u` },
  { id: "kids", label: "少儿", url: `${BASE}/categories/kids.m3u` },
  { id: "documentary", label: "纪录片", url: `${BASE}/categories/documentary.m3u` },
];

function findGroup(groupId) {
  return GROUPS.find((g) => g.id === groupId) || GROUPS[0];
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

// 去掉名字末尾的 [Geo-blocked] / [Not 24/7] 这类标注
function cleanName(name) {
  let n = (name || "").trim();
  let prev;
  do {
    prev = n;
    n = n.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  } while (n !== prev);
  return n;
}

function parseM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      const attrText = comma === -1 ? line.slice(8) : line.slice(8, comma);
      const name = comma === -1 ? "" : line.slice(comma + 1);
      pending = { attrs: parseAttrs(attrText), name: cleanName(name) };
    } else if (line.startsWith("#")) {
      continue;
    } else if (pending) {
      const url = line;
      if (/^https?:\/\//i.test(url) && pending.name) {
        channels.push({ name: pending.name, logo: pending.attrs["tvg-logo"] || "", url });
      }
      pending = null;
    }
  }
  return channels;
}

function detectFormat(url) {
  const clean = url.split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "hls";
  if (clean.endsWith(".mpd")) return "dash";
  if (/\.(mp4|m4v|ts|mov)$/.test(clean)) return "progressive";
  return "hls"; // iptv-org 里无扩展名的入口多为 HLS
}

export default function (hg) {
  const formats = (hg.env && hg.env.media && hg.env.media.formats) || ["hls", "progressive"];

  async function loadChannels(group, ctx) {
    let res;
    try {
      res = await hg.http.fetch({
        url: group.url,
        responseType: "text",
        timeoutMs: 20000,
        retry: 1,
        cache: { ttlSec: 3600, staleIfErrorSec: 86400 },
        signal: ctx && ctx.signal,
      });
    } catch (err) {
      if (err && err.code) throw err;
      throw new hg.PluginError("NETWORK", "拉取频道列表失败，请检查网络");
    }
    if (!res.ok) {
      throw new hg.PluginError("UPSTREAM_ERROR", `上游列表返回 ${res.status}，稍后重试`);
    }
    const all = parseM3U(res.data);
    if (!all.length) {
      throw new hg.PluginError("UPSTREAM_CHANGED", "上游列表结构变了，插件需要更新");
    }
    // 宿主不支持 DASH 时先滤掉 DASH 台，避免点进去才发现播不了
    return formats.includes("dash") ? all : all.filter((c) => detectFormat(c.url) !== "dash");
  }

  function toChannel(group, ch, index) {
    const item = {
      id: `${group.id}:${index}`,
      name: ch.name,
      number: index + 1,
      groupId: group.id,
    };
    if (ch.logo && /^https?:\/\//i.test(ch.logo)) item.logo = ch.logo;
    return item;
  }

  return {
    live: {
      getGroups() {
        return GROUPS.map(({ id, label }) => ({ id, label }));
      },

      async listChannels({ groupId, cursor, limit }, ctx) {
        const group = findGroup(groupId);
        const channels = await loadChannels(group, ctx);
        const pageSize = Math.min(Math.max(limit || 50, 1), 100);
        const offset = Math.max(parseInt(cursor || "0", 10) || 0, 0);
        const page = channels.slice(offset, offset + pageSize);
        return {
          items: page.map((ch, i) => toChannel(group, ch, offset + i)),
          next: offset + pageSize < channels.length ? String(offset + pageSize) : null,
          total: channels.length,
        };
      },

      async resolve({ channelId }, ctx) {
        const sep = String(channelId || "").lastIndexOf(":");
        if (sep <= 0) throw new hg.PluginError("NOT_FOUND", "频道不存在");
        const group = findGroup(channelId.slice(0, sep));
        const index = parseInt(channelId.slice(sep + 1), 10);
        if (!Number.isInteger(index) || index < 0) {
          throw new hg.PluginError("NOT_FOUND", "频道不存在");
        }
        const channels = await loadChannels(group, ctx);
        const ch = channels[index];
        if (!ch) throw new hg.PluginError("NOT_FOUND", "频道不存在");
        const format = detectFormat(ch.url);
        if (format === "dash" && !formats.includes("dash")) {
          throw new hg.PluginError("CONTENT_LOCKED", "该频道为 DASH 流，当前播放器不支持");
        }
        return {
          streams: [{ url: ch.url, format, live: true, label: ch.name }],
        };
      },
    },
  };
}
