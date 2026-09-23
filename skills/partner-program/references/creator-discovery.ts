// =============================================================================
// Creator discovery — official APIs only, one pipeline (crm_creator_prospects).
// Pattern, not a drop-in. Each source is optional: set its keys and it runs.
//
//   youtube(query)       YouTube Data API v3: search.list (channels) → channels.list (stats)
//                        env YOUTUBE_API_KEY · quota 10,000 units/day, search = 100, channels = 1
//   instagram(handles)   Instagram Graph API business_discovery — enrich KNOWN handles
//                        (followers, recent likes/comments). env IG_USER_ID, META_GRAPH_TOKEN
//   tiktok(filters)      TikTok One Creator Marketplace: GET /open_api/v1.3/tto/tcm/creator/discover/
//                        env TIKTOK_TTO_TOKEN, TIKTOK_TTO_ACCOUNT_ID · page_size ≤ 200
//   upsertProspects(db)  idempotent on (platform, external_id); growth-optimizer scores fit_score
//
// Inbound applications (a /partners/apply form) write the same rows with source='application'.
// =============================================================================
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
export type Prospect = {
  platform: "youtube" | "instagram" | "tiktok"; externalId: string; handle: string;
  followers?: number; avgViews?: number; engagementBps?: number; niches?: string[];
  email?: string | null; source: string; raw?: Record<string, unknown>;
};
const GRAPH = `${process.env.META_GRAPH_BASE ?? "https://graph.facebook.com"}/${process.env.META_GRAPH_VERSION ?? "v26.0"}`;
const YT = process.env.YOUTUBE_BASE ?? "https://www.googleapis.com/youtube/v3";
const TT = process.env.TIKTOK_BASE ?? "https://business-api.tiktok.com/open_api/v1.3";

// ---- YouTube ---------------------------------------------------------------------------------
export async function youtube(query: string, max = 25): Promise<Prospect[]> {
  const key = process.env.YOUTUBE_API_KEY!;
  const s = await (await fetch(`${YT}/search?part=snippet&type=channel&maxResults=${Math.min(max, 50)}&q=${encodeURIComponent(query)}&key=${key}`)).json() as
    { items?: { id: { channelId: string } }[]; error?: { message: string } };
  if (s.error) throw new Error(`youtube search: ${s.error.message}`);
  const ids = (s.items ?? []).map((i) => i.id.channelId);
  if (!ids.length) return [];
  const c = await (await fetch(`${YT}/channels?part=snippet,statistics&id=${ids.join(",")}&key=${key}`)).json() as
    { items: { id: string; snippet: { title: string; customUrl?: string; description: string }; statistics: { subscriberCount?: string; viewCount: string; videoCount: string } }[] };
  return c.items.map((ch) => {
    const videos = Number(ch.statistics.videoCount) || 1;
    return {
      platform: "youtube", externalId: ch.id, handle: ch.snippet.customUrl ?? ch.snippet.title,
      followers: Number(ch.statistics.subscriberCount ?? 0), avgViews: Math.round(Number(ch.statistics.viewCount) / videos),
      niches: [query], email: ch.snippet.description.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? null,
      source: "youtube_api", raw: ch as unknown as Record<string, unknown>,
    } satisfies Prospect;
  });
}

// ---- Instagram (business/creator accounts) --------------------------------------------------
export async function instagram(handles: string[]): Promise<Prospect[]> {
  const out: Prospect[] = [];
  for (const handle of handles) {
    const f = `business_discovery.username(${handle.replace(/^@/, "")}){id,username,followers_count,media_count,biography,media.limit(12){like_count,comments_count}}`;
    const j = await (await fetch(`${GRAPH}/${process.env.IG_USER_ID}?fields=${encodeURIComponent(f)}&access_token=${process.env.META_GRAPH_TOKEN}`)).json() as
      { business_discovery?: { id: string; username: string; followers_count: number; biography?: string; media?: { data: { like_count?: number; comments_count?: number }[] } }; error?: { message: string } };
    const b = j.business_discovery;
    if (!b) continue;   // personal accounts aren't discoverable — only business/creator accounts
    const media = b.media?.data ?? [];
    const avgEng = media.length ? media.reduce((a, m) => a + (m.like_count ?? 0) + (m.comments_count ?? 0), 0) / media.length : 0;
    out.push({
      platform: "instagram", externalId: b.id, handle: b.username, followers: b.followers_count,
      engagementBps: b.followers_count ? Math.round((avgEng / b.followers_count) * 10_000) : undefined,
      email: b.biography?.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? null, source: "ig_business_discovery", raw: b as unknown as Record<string, unknown>,
    });
  }
  return out;
}

// ---- TikTok One Creator Marketplace ----------------------------------------------------------
export async function tiktok(f: { countryCodes: string[]; keyword?: string; minFollowers?: number; minEngagementRate?: number; pageSize?: number }): Promise<Prospect[]> {
  const q = new URLSearchParams({
    tto_tcm_account_id: process.env.TIKTOK_TTO_ACCOUNT_ID!, country_codes: JSON.stringify(f.countryCodes),
    page_size: String(Math.min(f.pageSize ?? 50, 200)), sort_field: "ENGAGEMENT_RATE",
    ...(f.keyword ? { keyword_search: f.keyword.slice(0, 100) } : {}),
    ...(f.minFollowers ? { min_followers: String(f.minFollowers) } : {}),
    ...(f.minEngagementRate ? { min_engagement_rate: String(f.minEngagementRate) } : {}),
  });
  const j = await (await fetch(`${TT}/tto/tcm/creator/discover/?${q}`, { headers: { "Access-Token": process.env.TIKTOK_TTO_TOKEN! } })).json() as
    { code: number; message: string; data?: { creators: { handle_name: string; display_name: string; followers_count: number; likes_count: number; videos_count: number }[] } };
  if (j.code !== 0) throw new Error(`tiktok one: ${j.code} ${j.message}`);
  return (j.data?.creators ?? []).map((c) => ({
    platform: "tiktok", externalId: c.handle_name, handle: c.handle_name, followers: c.followers_count,
    avgViews: undefined, niches: f.keyword ? [f.keyword] : [], source: "tiktok_one", raw: c as unknown as Record<string, unknown>,
  }));
}

// ---- one pipeline --------------------------------------------------------------------------
export async function upsertProspects(db: Db, ps: Prospect[]) {
  for (const p of ps) {
    await db.execute(sql`
      insert into crm_creator_prospects (platform, external_id, handle, followers, avg_views, engagement_bps, niches, email, source, raw)
      values (${p.platform}, ${p.externalId}, ${p.handle}, ${p.followers ?? null}, ${p.avgViews ?? null}, ${p.engagementBps ?? null},
              string_to_array(${(p.niches ?? []).join("\u001f")}, '\u001f'), ${p.email ?? null}, ${p.source}, ${JSON.stringify(p.raw ?? {})}::jsonb)
      on conflict (platform, external_id) do update set
        handle = excluded.handle, followers = excluded.followers, avg_views = coalesce(excluded.avg_views, crm_creator_prospects.avg_views),
        engagement_bps = coalesce(excluded.engagement_bps, crm_creator_prospects.engagement_bps),
        niches = (select array_agg(distinct n) from unnest(crm_creator_prospects.niches || excluded.niches) n where n <> ''),
        email = coalesce(crm_creator_prospects.email, excluded.email), raw = excluded.raw`);
  }
  return ps.length;
}
