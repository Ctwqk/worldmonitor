import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

// Fetch with timeout
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// Allowed RSS feed domains for security
const ALLOWED_DOMAINS = [
  'feeds.bbci.co.uk',
  'www.bbc.com',
  'www.theguardian.com',
  'feeds.npr.org',
  'news.google.com',
  'www.aljazeera.com',
  'www.aljazeera.net',
  'rss.cnn.com',
  'hnrss.org',
  'feeds.arstechnica.com',
  'www.theverge.com',
  'www.cnbc.com',
  'feeds.marketwatch.com',
  'www.defenseone.com',
  'breakingdefense.com',
  'www.bellingcat.com',
  'techcrunch.com',
  'huggingface.co',
  'www.technologyreview.com',
  'rss.arxiv.org',
  'export.arxiv.org',
  'www.federalreserve.gov',
  'www.sec.gov',
  'www.whitehouse.gov',
  'www.state.gov',
  'www.defense.gov',
  'home.treasury.gov',
  'www.justice.gov',
  'tools.cdc.gov',
  'www.fema.gov',
  'www.dhs.gov',
  'www.thedrive.com',
  'krebsonsecurity.com',
  'finance.yahoo.com',
  'thediplomat.com',
  'venturebeat.com',
  'foreignpolicy.com',
  'www.ft.com',
  'openai.com',
  'www.reutersagency.com',
  'feeds.reuters.com',
  'rsshub.app',
  'asia.nikkei.com',
  'www.cfr.org',
  'www.csis.org',
  'www.politico.com',
  'www.brookings.edu',
  'layoffs.fyi',
  'www.defensenews.com',
  'www.foreignaffairs.com',
  'www.atlanticcouncil.org',
  // Tech variant domains
  'www.zdnet.com',
  'www.techmeme.com',
  'www.darkreading.com',
  'www.schneier.com',
  'rss.politico.com',
  'www.anandtech.com',
  'www.tomshardware.com',
  'www.semianalysis.com',
  'feed.infoq.com',
  'thenewstack.io',
  'devops.com',
  'dev.to',
  'lobste.rs',
  'changelog.com',
  'seekingalpha.com',
  'news.crunchbase.com',
  'www.saastr.com',
  'feeds.feedburner.com',
  // Additional tech variant domains
  'www.producthunt.com',
  'www.axios.com',
  'github.blog',
  'githubnext.com',
  'mshibanami.github.io',
  'www.engadget.com',
  'news.mit.edu',
  'dev.events',
  // VC blogs
  'www.ycombinator.com',
  'a16z.com',
  'review.firstround.com',
  'www.sequoiacap.com',
  'www.nfx.com',
  'www.aaronsw.com',
  'bothsidesofthetable.com',
  'www.lennysnewsletter.com',
  'stratechery.com',
  // Regional startup news
  'www.eu-startups.com',
  'tech.eu',
  'sifted.eu',
  'www.techinasia.com',
  'kr-asia.com',
  'techcabal.com',
  'disrupt-africa.com',
  'lavca.org',
  'contxto.com',
  'inc42.com',
  'yourstory.com',
  // Funding & VC
  'pitchbook.com',
  'www.cbinsights.com',
  // Accelerators
  'www.techstars.com',
  // Middle East & Regional News
  'english.alarabiya.net',
  'www.arabnews.com',
  'www.timesofisrael.com',
  'www.haaretz.com',
  'www.scmp.com',
  'kyivindependent.com',
  'www.themoscowtimes.com',
  'feeds.24.com',
  'feeds.capi24.com',  // News24 redirect destination
  // International News Sources
  'www.france24.com',
  'www.euronews.com',
  'fr.euronews.com',
  'de.euronews.com',
  'it.euronews.com',
  'es.euronews.com',
  'pt.euronews.com',
  'ru.euronews.com',
  'www.lemonde.fr',
  'feeds.elpais.com',
  'e00-elmundo.uecdn.es',
  'www.tagesschau.de',
  'www.spiegel.de',
  'newsfeed.zeit.de',
  'www.ansa.it',
  'xml2.corriereobjects.it',
  'www.repubblica.it',
  'feeds.nos.nl',
  'www.nrc.nl',
  'www.telegraaf.nl',
  'www.svt.se',
  'www.dn.se',
  'www.svd.se',
  'rss.dw.com',
  'www.africanews.com',
  'fr.africanews.com',
  'www.jeuneafrique.com',
  'www.lorientlejour.com',
  'www.clarin.com',
  'oglobo.globo.com',
  'feeds.folha.uol.com.br',
  'www.eltiempo.com',
  'www.eluniversal.com.mx',
  'www.lasillavacia.com',
  'www.channelnewsasia.com',
  'www.thehindu.com',
  'www.asahi.com',
  // International Organizations
  'news.un.org',
  'www.iaea.org',
  'www.who.int',
  'www.cisa.gov',
  'www.crisisgroup.org',
  // Think Tanks & Research (Added 2026-01-29)
  'rusi.org',
  'warontherocks.com',
  'www.aei.org',
  'responsiblestatecraft.org',
  'www.fpri.org',
  'jamestown.org',
  'www.chathamhouse.org',
  'ecfr.eu',
  'www.gmfus.org',
  'www.wilsoncenter.org',
  'www.lowyinstitute.org',
  'www.mei.edu',
  'www.stimson.org',
  'www.cnas.org',
  'carnegieendowment.org',
  'www.rand.org',
  'fas.org',
  'www.armscontrol.org',
  'www.nti.org',
  'thebulletin.org',
  'www.iss.europa.eu',
  // Economic & Food Security
  'www.fao.org',
  'worldbank.org',
  'www.imf.org',
  // Additional
  'news.ycombinator.com',
  // Finance variant
  'seekingalpha.com',
  'www.coindesk.com',
  'cointelegraph.com',
];

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function assertAllowedDomain(url) {
  const parsedUrl = new URL(url);
  if (!ALLOWED_DOMAINS.includes(parsedUrl.hostname)) {
    throw new Error(`Domain not allowed: ${parsedUrl.hostname}`);
  }
}

async function fetchAllowedFeed(feedUrl, timeout, maxRedirects = 4) {
  let currentUrl = feedUrl;

  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    assertAllowedDomain(currentUrl);

    const response = await fetchWithTimeout(currentUrl, {
      headers: REQUEST_HEADERS,
      redirect: 'manual',
    }, timeout);

    if (!(response.status >= 300 && response.status < 400)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    currentUrl = new URL(location, currentUrl).href;
  }

  throw new Error('Too many redirects');
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestUrl = new URL(req.url);
  const feedUrl = requestUrl.searchParams.get('url');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    try {
      assertAllowedDomain(feedUrl);
    } catch {
      return new Response(JSON.stringify({ error: 'Domain not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Fail faster on slow feeds; the client already falls back to cached feed data.
    const isGoogleNews = feedUrl.includes('news.google.com');
    const timeout = isGoogleNews ? 12000 : 8000;

    const response = await fetchAllowedFeed(feedUrl, timeout);

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    const isDisallowed = String(error?.message || '').startsWith('Domain not allowed:');
    console.error('RSS proxy error:', feedUrl, error.message);
    return new Response(JSON.stringify({
      error: isDisallowed ? 'Domain not allowed' : isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
      details: error.message,
      url: feedUrl
    }), {
      status: isDisallowed ? 403 : isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
