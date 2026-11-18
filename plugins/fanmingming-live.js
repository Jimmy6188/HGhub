// fanmingming 国内直播插件 · HGhub HPP protocol 1
// 数据源：fanmingming/live 开源维护的国内直播列表（https://github.com/fanmingming/live）
// 每日更新，央视+卫视+地方台。纯直播源：只实现 live 能力，不伪造点播详情。
// 频道 id 为“分组:序号”，解析时按序号从分组播放列表里取流地址。
// 列表地址走 jsDelivr 镜像（国内访问快）；直连 raw 备用：
//   https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/itv.m3u

export const meta = {
  id: "fanmingming.live",
  name: "国内直播",
  version: "1.0.0",
  protocol: 1,
  description: "fanmingming 国内直播源：央视、卫视、地方台，每日更新，信号源质量以各台实际为准。",
  author: "Muse",
  homepage: "https://github.com/fanmingming/live",
  allowInsecureHttp: true,
  timeouts: { read: 25, playback: 20 },
};

const BASE = "https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/m3u";

const GROUPS = [
  { id: "itv", label: "央视卫视", url: `${BASE}/itv.m3u` },
  { id: "ipv6", label: "央视卫视 IPv6", url: `${BASE}/ipv6.m3u` },
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
  return "hls"; // 无扩展名的入口多为 HLS
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
