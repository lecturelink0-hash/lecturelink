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

type EuropePmcSearchResponse = {
  resultList?: {
    result?: Array<{
      id?: string;
      pmid?: string;
      source?: string;
      title?: string;
      journalTitle?: string;
      abstractText?: string;
    }>;
  };
};

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function cleanSearchQuery(query: string) {
  return query
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

async function fetchPubMed(url: URL, accept: string) {
  let lastError = 'pubmed_request_failed';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'LectureLink-Medical-Education/1.0 (PubMed source verification)',
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return response;
      lastError = `pubmed_http_${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
      const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      if (attempt < 3) {
        const retryDelay = Number.isFinite(retryAfterSeconds)
          ? Math.min(retryAfterSeconds * 1000, 3_000)
          : attempt * 450;
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 450));
    }
  }
  throw new Error(lastError.slice(0, 240));
}

async function fetchJson<T>(url: URL): Promise<T> {
  return (await fetchPubMed(url, 'application/json')).json() as Promise<T>;
}

async function fetchText(url: URL): Promise<string> {
  return (await fetchPubMed(url, 'application/xml,text/xml')).text();
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

async function findNlmPubMedSources(
  searchQueries: string[],
  limit = 5,
): Promise<VerifiedMedicalSource[]> {
  const queries = Array.from(new Set(searchQueries.map(cleanSearchQuery).filter(Boolean))).slice(0, 4);
  if (queries.length === 0) return [];

  const topicTerm = `(${queries.map((query) => `(${query})`).join(' OR ')})`;
  const candidateLimit = Math.max(8, Math.min(limit * 2, 12));
  const searchIds = async (term: string) => {
    const searchUrl = new URL(`${EUTILS_BASE}/esearch.fcgi`);
    searchUrl.search = new URLSearchParams({
      db: 'pubmed',
      retmode: 'json',
      retmax: String(candidateLimit),
      sort: 'relevance',
      term,
    }).toString();
    const search = await fetchJson<PubMedSearchResponse>(searchUrl);
    return (search.esearchresult?.idlist ?? []).filter((id) => /^\d+$/.test(id));
  };

  const preferredIds = await searchIds(`${topicTerm} AND (review[Publication Type] OR guideline[Publication Type] OR practice guideline[Publication Type]) AND humans[MeSH Terms]`);
  const broaderIds = preferredIds.length >= candidateLimit
    ? []
    : await searchIds(`${topicTerm} AND humans[MeSH Terms]`);
  const collectedIds = Array.from(new Set([...preferredIds, ...broaderIds]));
  for (const query of queries) {
    if (collectedIds.length >= candidateLimit) break;
    const individualIds = await searchIds(`(${query}) AND humans[MeSH Terms]`);
    for (const id of individualIds) {
      if (!collectedIds.includes(id)) collectedIds.push(id);
      if (collectedIds.length >= candidateLimit) break;
    }
  }
  const ids = collectedIds.slice(0, candidateLimit);
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
  }).slice(0, limit);
}

async function findEuropePmcSources(searchQueries: string[], limit: number) {
  const queries = Array.from(new Set(searchQueries.map(cleanSearchQuery).filter(Boolean))).slice(0, 4);
  if (!queries.length) return [];
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  url.search = new URLSearchParams({
    query: `(${queries.map((query) => `(${query})`).join(' OR ')}) AND SRC:MED AND HAS_ABSTRACT:Y`,
    resultType: 'core',
    format: 'json',
    pageSize: String(Math.max(5, Math.min(limit * 2, 12))),
  }).toString();
  const response = await fetchJson<EuropePmcSearchResponse>(url);
  return (response.resultList?.result ?? []).flatMap((item) => {
    const title = item.title?.trim().replace(/\.$/, '') ?? '';
    const evidence = item.abstractText?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3_000) ?? '';
    const pmid = item.pmid?.trim() ?? '';
    const source = item.source?.trim() || 'MED';
    const id = item.id?.trim() || pmid;
    if (!title || evidence.length < 80 || (!pmid && !id)) return [];
    return [{
      title,
      organization: item.journalTitle?.trim()
        ? `Europe PMC · ${item.journalTitle.trim()}`
        : 'Europe PMC · EMBL-EBI',
      url: /^\d+$/.test(pmid)
        ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
        : `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      evidence,
    }];
  }).slice(0, limit) satisfies VerifiedMedicalSource[];
}

export async function findVerifiedPubMedSources(
  searchQueries: string[],
  limit = 5,
): Promise<VerifiedMedicalSource[]> {
  let primary: VerifiedMedicalSource[] = [];
  try {
    primary = await findNlmPubMedSources(searchQueries, limit);
  } catch (error) {
    console.warn('[medical-sources]', {
      stage: 'nlm_lookup_failed',
      cause: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    });
  }
  if (primary.length >= Math.min(2, limit)) return primary;

  try {
    const fallback = await findEuropePmcSources(searchQueries, limit);
    return [...primary, ...fallback]
      .filter((source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index)
      .slice(0, limit);
  } catch (error) {
    console.warn('[medical-sources]', {
      stage: 'europe_pmc_lookup_failed',
      cause: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    });
    return primary;
  }
}
