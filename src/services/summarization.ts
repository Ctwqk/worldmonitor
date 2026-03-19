/**
 * Summarization Service with Fallback Chain
 * Server-side Redis caching handles cross-user deduplication
 * Fallback: Watchdog-managed route -> Groq -> OpenRouter -> Browser T5
 */

import { mlWorker } from './ml-worker';
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import { isFeatureAvailable } from './runtime-config';

export type SummarizationProvider = 'groq' | 'openrouter' | 'exo' | 'watchdog' | 'gateway' | 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

async function tryGroq(headlines: string[], geoContext?: string, lang?: string): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable('aiGroq')) return null;
  try {
    const response = await fetch('/api/groq-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`Groq error: ${response.status}`);
    }

    const data = await response.json();
    const provider = data.cached ? 'cache' : 'groq';
    console.log(`[Summarization] ${provider === 'cache' ? 'Redis cache hit' : 'Groq success'}:`, data.model);
    return {
      summary: data.summary,
      provider: provider as SummarizationProvider,
      cached: !!data.cached,
    };
  } catch (error) {
    console.warn('[Summarization] Groq failed:', error);
    return null;
  }
}

async function tryOpenRouter(headlines: string[], geoContext?: string, lang?: string): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable('aiOpenRouter')) return null;
  try {
    const response = await fetch('/api/openrouter-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`OpenRouter error: ${response.status}`);
    }

    const data = await response.json();
    const provider = data.cached ? 'cache' : 'openrouter';
    console.log(`[Summarization] ${provider === 'cache' ? 'Redis cache hit' : 'OpenRouter success'}:`, data.model);
    return {
      summary: data.summary,
      provider: provider as SummarizationProvider,
      cached: !!data.cached,
    };
  } catch (error) {
    console.warn('[Summarization] OpenRouter failed:', error);
    return null;
  }
}

async function tryExo(headlines: string[], geoContext?: string, lang?: string): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable('aiExo')) return null;
  try {
    const response = await fetch('/api/exo-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`Local LLM error: ${response.status}`);
    }

    const data = await response.json();
    const provider = data.cached ? 'cache' : (data.provider || 'watchdog');
    console.log(`[Summarization] ${provider === 'cache' ? 'Redis cache hit' : 'Watchdog route success'}:`, data.model);
    return {
      summary: data.summary,
      provider: provider as SummarizationProvider,
      cached: !!data.cached,
    };
  } catch (error) {
    console.warn('[Summarization] Local LLM failed:', error);
    return null;
  }
}

async function tryBrowserT5(headlines: string[], modelId?: string): Promise<SummarizationResult | null> {
  try {
    if (!mlWorker.isAvailable) {
      console.log('[Summarization] Browser ML not available');
      return null;
    }

    const combinedText = headlines.slice(0, 6).map(h => h.slice(0, 80)).join('. ');
    const prompt = `Summarize the main themes from these news headlines in 2 sentences: ${combinedText}`;

    const [summary] = await mlWorker.summarize([prompt], modelId);

    if (!summary || summary.length < 20 || summary.toLowerCase().includes('summarize')) {
      return null;
    }

    console.log('[Summarization] Browser T5 success');
    return {
      summary,
      provider: 'browser',
      cached: false,
    };
  } catch (error) {
    console.warn('[Summarization] Browser T5 failed:', error);
    return null;
  }
}

/**
 * Generate a summary using the fallback chain: Groq -> OpenRouter -> Local LLM -> Browser T5
 * Server-side Redis caching is handled by the API endpoints
 * @param geoContext Optional geographic signal context to include in the prompt
 */
export async function generateSummary(
  headlines: string[],
  onProgress?: ProgressCallback,
  geoContext?: string,
  lang: string = 'en'
): Promise<SummarizationResult | null> {
  if (!headlines || headlines.length < 2) {
    return null;
  }

  if (BETA_MODE) {
    const modelReady = mlWorker.isAvailable && mlWorker.isModelLoaded('summarization-beta');

    if (modelReady) {
      const totalSteps = 4;
      // Model already loaded — use browser T5-small first
      onProgress?.(1, totalSteps, 'Running local AI model (beta)...');
      const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
      if (browserResult) {
        console.log('[BETA] Browser T5-small:', browserResult.summary);
        tryGroq(headlines, geoContext).then(r => {
          if (r) console.log('[BETA] Groq comparison:', r.summary);
        }).catch(() => {});
        return browserResult;
      }

      // Warm model failed inference — cloud fallback
      onProgress?.(2, totalSteps, 'Connecting to Groq AI...');
      const groqResult = await tryGroq(headlines, geoContext);
      if (groqResult) return groqResult;

      onProgress?.(3, totalSteps, 'Trying OpenRouter...');
      const openRouterResult = await tryOpenRouter(headlines, geoContext);
      if (openRouterResult) return openRouterResult;

      onProgress?.(4, totalSteps, 'Trying Local LLM...');
      const exoResult = await tryExo(headlines, geoContext);
      if (exoResult) return exoResult;
    } else {
      const totalSteps = 5;
      console.log('[BETA] T5-small not loaded yet, using cloud providers first');
      // Kick off model load in background for next time
      if (mlWorker.isAvailable) {
        mlWorker.loadModel('summarization-beta').catch(() => {});
      }

      // Cloud providers while model loads
      onProgress?.(1, totalSteps, 'Connecting to Groq AI...');
      const groqResult = await tryGroq(headlines, geoContext);
      if (groqResult) {
        console.log('[BETA] Groq:', groqResult.summary);
        return groqResult;
      }

      onProgress?.(2, totalSteps, 'Trying OpenRouter...');
      const openRouterResult = await tryOpenRouter(headlines, geoContext);
      if (openRouterResult) return openRouterResult;

      onProgress?.(3, totalSteps, 'Trying Local LLM...');
      const exoResult = await tryExo(headlines, geoContext);
      if (exoResult) return exoResult;

      // Last resort: try browser T5 (may have finished loading by now)
      if (mlWorker.isAvailable) {
        onProgress?.(4, totalSteps, 'Waiting for local AI model...');
        const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
        if (browserResult) return browserResult;
      }

      onProgress?.(5, totalSteps, 'No providers available');
    }

    console.warn('[BETA] All providers failed');
    return null;
  }

  const totalSteps = 4;

  // Step 1: Try the managed watchdog route first.
  onProgress?.(1, totalSteps, 'Checking watchdog LLM route...');
  const exoResult = await tryExo(headlines, geoContext, lang);
  if (exoResult) {
    return exoResult;
  }

  // Step 2: Direct provider fallback if watchdog is unavailable.
  onProgress?.(2, totalSteps, 'Connecting to Groq AI...');
  const groqResult = await tryGroq(headlines, geoContext, lang);
  if (groqResult) {
    return groqResult;
  }

  // Step 3: Try OpenRouter.
  onProgress?.(3, totalSteps, 'Trying OpenRouter...');
  const openRouterResult = await tryOpenRouter(headlines, geoContext, lang);
  if (openRouterResult) {
    return openRouterResult;
  }

  // Step 4: Try Browser T5 (local, unlimited but slower)
  onProgress?.(4, totalSteps, 'Loading local AI model...');
  const browserResult = await tryBrowserT5(headlines);
  if (browserResult) {
    return browserResult;
  }

  console.warn('[Summarization] All providers failed');
  return null;
}


/**
 * Translate text using the fallback chain
 * @param text Text to translate
 * @param targetLang Target language code (e.g., 'fr', 'es')
 */
export async function translateText(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback
): Promise<string | null> {
  if (!text) return null;

  // Step 1: Try the managed watchdog route first.
  if (isFeatureAvailable('aiExo')) {
    onProgress?.(1, 3, 'Translating with watchdog route...');
    try {
      const response = await fetch('/api/exo-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.summary;
      }
    } catch (e) {
      console.warn('Watchdog translation failed', e);
    }
  }

  // Step 2: Try Groq.
  if (isFeatureAvailable('aiGroq')) {
    onProgress?.(2, 3, 'Translating with Groq...');
    try {
      const response = await fetch('/api/groq-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.summary;
      }
    } catch (e) {
      console.warn('Groq translation failed', e);
    }
  }

  // Step 3: Try OpenRouter.
  if (isFeatureAvailable('aiOpenRouter')) {
    onProgress?.(3, 3, 'Translating with OpenRouter...');
    try {
      const response = await fetch('/api/openrouter-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.summary;
      }
    } catch (e) {
      console.warn('OpenRouter translation failed', e);
    }
  }

  return null;
}
