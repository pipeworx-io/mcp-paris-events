interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Que Faire à Paris MCP.
 *
 * Official "what to do in Paris" events from the City of Paris open-data portal
 * (opendata.paris.fr, "que-faire-a-paris-" dataset, Opendatasoft v2.1 API).
 * Keyless, ~2,700 current events. Filter by keyword, free admission, and date
 * window via ODSQL `where` clauses. Content is in French (Paris source).
 */


const BASE = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records';
const UA = 'pipeworx-mcp-paris-events/1.0 (+https://pipeworx.io)';
const MAX_LIMIT = 50;

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Find current "things to do" in Paris (Que Faire à Paris, City of Paris official events). Filter by keyword, free admission, and date window. Returns events sorted by start date. Note: titles/descriptions are in French.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (full-text), e.g. "jazz", "exposition", "marché". French terms match best.' },
        free_only: { type: 'boolean', description: 'If true, only free events (price_type = gratuit).' },
        from: { type: 'string', description: 'Include events running on/after this date YYYY-MM-DD (default: today). Ongoing/undated events are included.' },
        to: { type: 'string', description: 'Include events starting on/before this date YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max events (1-${MAX_LIMIT}, default 20).` },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const conds: string[] = [`(date_end >= date'${from}' or date_end is null)`];
  if (to) conds.push(`(date_start <= date'${to}' or date_start is null)`);
  if (args.free_only === true) conds.push(`price_type = "gratuit"`);
  if (typeof args.query === 'string' && args.query.trim()) conds.push(`"${args.query.trim().replace(/"/g, '')}"`);

  const qs = new URLSearchParams();
  qs.set('where', conds.join(' and '));
  qs.set('order_by', 'date_start');
  qs.set('limit', String(clamp(numArg(args.limit, 20), 1, MAX_LIMIT)));
  qs.set('offset', String(Math.max(0, numArg(args.offset, 0))));

  const res = await fetch(`${BASE}?${qs.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Que Faire à Paris: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 160))}`);
  const data = (await res.json()) as { total_count?: number; results?: QfapEvent[] };

  return {
    city: 'Paris',
    country: 'France',
    source: 'opendata.paris.fr',
    date_from: from,
    date_to: to || null,
    total_matching: data.total_count ?? 0,
    count: data.results?.length ?? 0,
    events: (data.results ?? []).map(normalize),
  };
}

interface QfapEvent {
  id?: string;
  title?: string;
  url?: string;
  lead_text?: string;
  description?: string;
  date_start?: string | null;
  date_end?: string | null;
  date_description?: string | null;
  address_name?: string;
  address_street?: string;
  address_zipcode?: string;
  address_city?: string;
  lat_lon?: { lat?: number; lon?: number } | null;
  price_type?: string;
  price_detail?: string | null;
  audience?: string | null;
  qfap_tags?: string | string[] | null;
  cover_url?: string | null;
  contact_url?: string | null;
  access_link?: string | null;
}

function normalize(e: QfapEvent): Record<string, unknown> {
  const ll = e.lat_lon && typeof e.lat_lon === 'object' ? e.lat_lon : undefined;
  const hasGeo = ll && (ll.lat || ll.lon);
  return {
    id: e.id,
    title: e.title,
    url: e.url,
    summary: strip(e.lead_text) || undefined,
    description: strip(e.description)?.slice(0, 800) || undefined,
    date_start: e.date_start || undefined,
    date_end: e.date_end || undefined,
    when: strip(e.date_description ?? undefined) || undefined,
    is_free: e.price_type === 'gratuit',
    price: strip(e.price_detail ?? undefined) || e.price_type || undefined,
    venue: e.address_name || e.address_street
      ? {
          name: e.address_name,
          address: [e.address_street, e.address_zipcode, e.address_city].filter((p) => p && p.trim()).join(', ') || undefined,
          latitude: hasGeo ? ll!.lat : undefined,
          longitude: hasGeo ? ll!.lon : undefined,
        }
      : undefined,
    audience: e.audience || undefined,
    tags: Array.isArray(e.qfap_tags) ? e.qfap_tags : e.qfap_tags ? [e.qfap_tags] : [],
    cover_url: e.cover_url || undefined,
    booking_url: e.access_link || e.contact_url || undefined,
  };
}

function strip(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&#339;|&oelig;/g, 'œ').replace(/&#39;|&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000); // approx Paris (CEST)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
