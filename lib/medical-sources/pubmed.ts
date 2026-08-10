export type VerifiedMedicalSource = {
  title: string;
  organization: string;
  url: string;
  evidence: string;
};

type PubMedSearchResponse = {
  esearchresult?: { idlist?: string[] };
};

type PubMedSummary = {
  uid?: string;
  title?: string;
  fulljournalname?: string;
};

type PubMedSummaryResponse = {
  result?: Record<string, PubMedSummary | string[]>;
};

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function cleanSearchQuery(query: string) {
  return query
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'LectureLink-Medical-Education/1.0 (PubMed source verification)',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`pubmed_http_${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchText(url: URL): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/xml,text/xml',
      'User-Agent': 'LectureLink-Medical-Education/1.0 (PubMed source verification)',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`pubmed_http_${response.status}`);
  return response.text();
}

function decodeXmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAbstracts(xml: string) {
  const abstracts = new Map<string, string>();
  for (const article of xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) ?? []) {
    const id = article.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!id) continue;
    const parts = Array.from(article.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g))
      .map((match) => decodeXmlText(match[1]))
      .filter(Boolean);
    if (parts.length > 0) abstracts.set(id, parts.join(' ').slice(0, 3_000));
  }
  return abstracts;
}

export async function findVerifiedPubMedSources(
  searchQueries: string[],
  limit = 5,
): Promise<VerifiedMedicalSource[]> {
  const queries = Array.from(new Set(searchQueries.map(cleanSearchQuery).filter(Boolean))).slice(0, 4);
  if (queries.length === 0) return [];

  const topicTerm = `(${queries.map((query) => `(${query})`).join(' OR ')})`;
  const searchIds = async (term: string) => {
    const searchUrl = new URL(`${EUTILS_BASE}/esearch.fcgi`);
    searchUrl.search = new URLSearchParams({
      db: 'pubmed',
      retmode: 'json',
      retmax: String(Math.max(2, Math.min(limit, 5))),
      sort: 'relevance',
      term,
    }).toString();
    const search = await fetchJson<PubMedSearchResponse>(searchUrl);
    return (search.esearchresult?.idlist ?? []).filter((id) => /^\d+$/.test(id));
  };

  const preferredIds = await searchIds(`${topicTerm} AND (review[Publication Type] OR guideline[Publication Type] OR practice guideline[Publication Type]) AND humans[MeSH Terms]`);
  const broaderIds = preferredIds.length >= limit
    ? []
    : await searchIds(`${topicTerm} AND humans[MeSH Terms]`);
  const ids = Array.from(new Set([...preferredIds, ...broaderIds])).slice(0, limit);
  if (ids.length === 0) return [];

  const summaryUrl = new URL(`${EUTILS_BASE}/esummary.fcgi`);
  summaryUrl.search = new URLSearchParams({
    db: 'pubmed',
    retmode: 'json',
    id: ids.join(','),
  }).toString();
  const summary = await fetchJson<PubMedSummaryResponse>(summaryUrl);

  const abstractUrl = new URL(`${EUTILS_BASE}/efetch.fcgi`);
  abstractUrl.search = new URLSearchParams({
    db: 'pubmed',
    retmode: 'xml',
    id: ids.join(','),
  }).toString();
  const abstracts = extractAbstracts(await fetchText(abstractUrl));

  return ids.flatMap((id) => {
    const item = summary.result?.[id];
    const evidence = abstracts.get(id) ?? '';
    if (!item || Array.isArray(item) || typeof item.title !== 'string' || !item.title.trim() || evidence.length < 80) return [];
    const journal = typeof item.fulljournalname === 'string' ? item.fulljournalname.trim() : '';
    return [{
      title: item.title.trim().replace(/\.$/, ''),
      organization: journal ? `PubMed · ${journal}` : 'PubMed · NLM/NIH',
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      evidence,
    }];
  });
}
