<template>
  <section class="mcp-app-result">
    <header class="mcp-app-result-header">
      <div class="mcp-app-result-heading">
        <Blocks class="mcp-app-result-icon" aria-hidden="true" />
        <div class="mcp-app-result-title-wrap">
          <h3 class="mcp-app-result-title">{{ result.appName }}</h3>
          <p v-if="resultSummary" class="mcp-app-result-summary">{{ resultSummary }}</p>
        </div>
      </div>
      <button
        v-if="widgetReady && hasNativeResults"
        class="mcp-app-result-view-toggle"
        type="button"
        @click="showNativeView = !showNativeView"
      >
        {{ showNativeView ? 'Interactive view' : 'Simple view' }}
      </button>
    </header>

    <div v-if="widgetSrcdoc" class="mcp-app-widget-shell">
      <iframe
        ref="iframeRef"
        class="mcp-app-widget-frame"
        :class="{ 'is-hidden': showNativeContent }"
        :style="{ height: `${widgetHeight}px` }"
        :srcdoc="widgetSrcdoc"
        :title="`${result.appName} interactive results`"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
      />
    </div>

    <div v-if="showNativeContent && nativeAccommodations.length > 0" class="mcp-app-native-results">
      <article
        v-for="accommodation in nativeAccommodations"
        :key="accommodation.id"
        class="mcp-app-accommodation"
      >
        <img
          v-if="accommodation.photoUrl"
          class="mcp-app-accommodation-photo"
          :src="accommodation.photoUrl"
          :alt="accommodation.name"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <div v-else class="mcp-app-accommodation-photo-placeholder">
          <Hotel aria-hidden="true" />
        </div>
        <div class="mcp-app-accommodation-body">
          <div class="mcp-app-accommodation-title-row">
            <h4 class="mcp-app-accommodation-name">{{ accommodation.name }}</h4>
            <span v-if="accommodation.reviewScore" class="mcp-app-accommodation-rating">
              <Star class="mcp-app-accommodation-rating-icon" aria-hidden="true" />
              {{ accommodation.reviewScore }}
            </span>
          </div>
          <p v-if="accommodation.location" class="mcp-app-accommodation-location">
            {{ accommodation.location }}
          </p>
          <div v-if="accommodation.facilities.length > 0" class="mcp-app-accommodation-facilities">
            <span v-for="facility in accommodation.facilities" :key="facility">{{ facility }}</span>
          </div>
          <div class="mcp-app-accommodation-footer">
            <div>
              <p v-if="accommodation.price" class="mcp-app-accommodation-price">
                {{ accommodation.price }}
              </p>
              <p v-if="accommodation.reviewCount" class="mcp-app-accommodation-reviews">
                {{ accommodation.reviewCount }} reviews
              </p>
            </div>
            <a
              v-if="accommodation.url"
              class="mcp-app-accommodation-link"
              :href="accommodation.url"
              target="_blank"
              rel="noreferrer noopener"
            >
              View on Booking.com
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="showNativeContent && nativeFlights.length > 0" class="mcp-app-native-results">
      <article v-for="flight in nativeFlights" :key="flight.id" class="mcp-app-flight">
        <div class="mcp-app-flight-top">
          <div class="mcp-app-flight-route">
            <Plane class="mcp-app-flight-icon" aria-hidden="true" />
            <div>
              <h4 class="mcp-app-flight-title">{{ flight.routeTitle }}</h4>
              <p v-if="flight.airline" class="mcp-app-flight-airline">{{ flight.airline }}</p>
            </div>
          </div>
          <p v-if="flight.price" class="mcp-app-accommodation-price">{{ flight.price }}</p>
        </div>
        <div class="mcp-app-flight-times">
          <div>
            <strong>{{ flight.departTime }}</strong>
            <span>{{ flight.departCode }}</span>
          </div>
          <div class="mcp-app-flight-duration">
            <span>{{ flight.duration }}</span>
            <span class="mcp-app-flight-line" aria-hidden="true" />
            <span>{{ flight.stopInfo }}</span>
          </div>
          <div class="mcp-app-flight-arrival">
            <strong>{{ flight.arriveTime }}</strong>
            <span>{{ flight.arriveCode }}</span>
          </div>
        </div>
        <div class="mcp-app-flight-footer">
          <p>{{ flight.date }}</p>
          <a
            v-if="flight.url"
            class="mcp-app-accommodation-link"
            :href="flight.url"
            target="_blank"
            rel="noreferrer noopener"
          >
            View on Trip.com
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </article>
    </div>

    <div
      v-else-if="showNativeContent && isLoadingResource"
      class="mcp-app-result-placeholder"
      aria-live="polite"
    >
      Loading interactive results…
    </div>
    <div
      v-else-if="showNativeContent && resourceError"
      class="mcp-app-result-placeholder"
      aria-live="polite"
    >
      Interactive results are unavailable for this response.
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Blocks, ExternalLink, Hotel, Plane, Star } from '@lucide/vue'
import { readMcpAppResource } from '../../api/codexGateway'
import type { McpAppResultData } from '../../types/codex'

type AccommodationCard = {
  id: string
  name: string
  url: string
  photoUrl: string
  location: string
  reviewScore: string
  reviewCount: string
  price: string
  facilities: string[]
}

type FlightCard = {
  id: string
  routeTitle: string
  airline: string
  price: string
  departTime: string
  departCode: string
  arriveTime: string
  arriveCode: string
  duration: string
  stopInfo: string
  date: string
  url: string
}

const props = defineProps<{
  result: McpAppResultData
  threadId?: string
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const widgetSrcdoc = ref('')
const widgetReady = ref(false)
const widgetMaxHeight = ref(computeWidgetMaxHeight())
const widgetMaxWidth = ref(computeWidgetMaxWidth())
const widgetHeight = ref(Math.min(500, widgetMaxHeight.value))
const showNativeView = ref(false)
const isLoadingResource = ref(false)
const resourceError = ref('')
const widgetId = `mcp-app-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
let resourceLoadVersion = 0
let themeObserver: MutationObserver | null = null

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readSafeUrl(value: unknown): string {
  const raw = readString(value)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function formatCurrency(value: number | null, currency: string): string {
  if (value === null || !currency) return ''
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value)
  } catch {
    return `${currency} ${value.toFixed(0)}`
  }
}

function formatReviewScore(value: number | null): string {
  if (value === null) return ''
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function parseFacilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const facilities: string[] = []
  for (const entry of value) {
    const text = readString(entry) || readString(asRecord(entry)?.text)
    if (text && !facilities.includes(text)) facilities.push(text)
    if (facilities.length >= 4) break
  }
  return facilities
}

const bookingWidgetMeta = computed(() => {
  const meta = asRecord(props.result.resultMeta)
  return asRecord(meta?.['booking.com/widget'])
})

const nativeAccommodationSource = computed<unknown[]>(() => {
  const metaRows = bookingWidgetMeta.value?.accommodations
  if (Array.isArray(metaRows)) return metaRows
  const structured = asRecord(props.result.structuredContent)
  return Array.isArray(structured?.accommodations) ? structured.accommodations : []
})

const nativeAccommodations = computed<AccommodationCard[]>(() =>
  nativeAccommodationSource.value.flatMap((entry, index) => {
    const row = asRecord(entry)
    if (!row) return []
    const name = readString(row.name)
    if (!name) return []

    const photo = asRecord(row.main_photo)
    const photoSizes = asRecord(photo?.sizes)
    const price = asRecord(row.price)
    const rating = asRecord(row.rating)
    const location = asRecord(row.location)
    const locationParts = [
      readString(location?.district_name),
      readString(location?.city_name),
      readString(location?.country_name),
    ].filter(Boolean)
    const bookPrice = readNumber(price?.book) ?? readNumber(price?.total)
    const currency = readString(price?.currency)

    return [{
      id: String(row.id ?? `${name}-${index}`),
      name,
      url: readSafeUrl(row.url) || readSafeUrl(row.see_more_url),
      photoUrl: readSafeUrl(photoSizes?.standard) || readSafeUrl(photo?.url),
      location: Array.from(new Set(locationParts)).join(' · '),
      reviewScore: formatReviewScore(readNumber(rating?.review_score)),
      reviewCount: String(readNumber(rating?.number_of_reviews) ?? ''),
      price: formatCurrency(bookPrice, currency),
      facilities: parseFacilities(row.facilities),
    }]
  }),
)

const nativeFlights = computed<FlightCard[]>(() => {
  const structured = asRecord(props.result.structuredContent)
  const flightResult = asRecord(structured?.flight)
  const rows = Array.isArray(flightResult?.flights)
    ? flightResult.flights
    : flightResult?.firstFlight
      ? [flightResult.firstFlight]
      : []
  return rows.flatMap((entry, index) => {
    const row = asRecord(entry)
    const journeys = Array.isArray(row?.journalList) ? row.journalList : []
    const outbound = asRecord(journeys[0])
    const journey = asRecord(outbound?.journal)
    if (!row || !journey) return []
    const segments = Array.isArray(outbound?.segments) ? outbound.segments : []
    const firstSegment = asRecord(segments[0])
    const deeplinks = asRecord(row.deeplinkUrls)
    const departTime = readString(journey.departTime)
    const arriveTime = readString(journey.arriveTime)
    const routeTitle = readString(row.routeTitle)
      || [readString(journey.departCityName), readString(journey.arriveCityName)].filter(Boolean).join(' to ')

    return [{
      id: `${routeTitle || 'flight'}-${index}`,
      routeTitle: routeTitle || 'Flight option',
      airline: readString(firstSegment?.airlineName),
      price: readString(row.formattedPrice)
        || formatCurrency(readNumber(row.price), readString(row.currency) || readString(structured?.currency)),
      departTime: formatTime(departTime),
      departCode: readString(journey.departCity) || readString(firstSegment?.departAirport),
      arriveTime: formatTime(arriveTime),
      arriveCode: readString(journey.arriveCity) || readString(firstSegment?.arriveAirport),
      duration: readString(journey.formatDuration) || formatDuration(readNumber(journey.duration)),
      stopInfo: readString(journey.stopInfo) || (journey.isTransfer === true ? 'Stops' : 'Direct'),
      date: readString(journey.formatDepartTime) || formatDate(departTime),
      url: readSafeUrl(deeplinks?.onlineUrl) || readSafeUrl(deeplinks?.h5MiddleUrl),
    }]
  })
})

const hasNativeResults = computed(() =>
  nativeAccommodations.value.length > 0 || nativeFlights.value.length > 0,
)

const resultSummary = computed(() => {
  if (nativeFlights.value.length > 0) {
    const structured = asRecord(props.result.structuredContent)
    const flightResult = asRecord(structured?.flight)
    const count = nativeFlights.value.length
    return [
      `${count} option${count === 1 ? '' : 's'}`,
      readString(flightResult?.searchSummary),
    ].filter(Boolean).join(' · ')
  }

  const stay = asRecord(bookingWidgetMeta.value?.stay_details)
  const input = asRecord(props.result.toolInput)
  const checkin = readString(stay?.checkin) || readString(input?.checkin_date)
  const checkout = readString(stay?.checkout) || readString(input?.checkout_date)
  const count = nativeAccommodations.value.length
  const parts = [
    count > 0 ? `${count} stay${count === 1 ? '' : 's'}` : '',
    checkin && checkout ? `${checkin} – ${checkout}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
})

function formatTime(value: string): string {
  if (!value) return ''
  const match = value.match(/[T\s](\d{2}:\d{2})/u)
  return match?.[1] ?? value
}

function formatDate(value: string): string {
  if (!value) return ''
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value.split(' ')[0] ?? value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function formatDuration(value: number | null): string {
  if (value === null) return ''
  const hours = Math.floor(value / 60)
  const minutes = value % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

const showNativeContent = computed(() =>
  showNativeView.value || !widgetReady.value || !widgetSrcdoc.value,
)

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function computeWidgetMaxHeight(): number {
  if (typeof window === 'undefined') return 680
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  return window.innerWidth <= 768
    ? Math.max(240, Math.min(680, Math.floor(viewportHeight * 0.72)))
    : 680
}

function computeWidgetMaxWidth(): number {
  if (typeof window === 'undefined') return 640
  return Math.max(280, Math.floor(window.innerWidth - 32))
}

function currentSurfaceBackgroundColor(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--surface-elevated')
    .trim()
}

function normalizeCspDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const domain = readString(entry)
    return /^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/iu.test(domain) ? [domain] : []
  })
}

function buildWidgetCsp(meta: Record<string, unknown>): string {
  const legacy = asRecord(meta['openai/widgetCSP'])
  const standard = asRecord(asRecord(meta.ui)?.csp)
  const resourceDomains = normalizeCspDomains(
    legacy?.resource_domains ?? standard?.resourceDomains,
  )
  const connectDomains = normalizeCspDomains(
    legacy?.connect_domains ?? standard?.connectDomains,
  )
  const frameDomains = normalizeCspDomains(
    legacy?.frame_domains ?? standard?.frameDomains,
  )
  const resourceSources = resourceDomains.join(' ')
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' ${resourceSources}`.trim(),
    `style-src 'unsafe-inline' ${resourceSources}`.trim(),
    `img-src data: blob: ${resourceSources}`.trim(),
    `font-src data: ${resourceSources}`.trim(),
    `connect-src ${connectDomains.join(' ') || "'none'"}`,
    `frame-src ${frameDomains.join(' ') || "'none'"}`,
    `media-src ${resourceSources || "'none'"}`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ')
}

function createOpenAiBridgeScript(): string {
  const globals = {
    theme: currentTheme(),
    locale: navigator.language || 'en-US',
    displayMode: 'inline',
    maxHeight: widgetMaxHeight.value,
    maxWidth: widgetMaxWidth.value,
    surfaceBackgroundColor: currentSurfaceBackgroundColor(),
    toolInput: props.result.toolInput,
    toolOutput: props.result.structuredContent,
    toolResponseMetadata: props.result.resultMeta,
    widgetState: null,
  }
  return `<script>
(() => {
  const widgetId = ${serializeForInlineScript(widgetId)};
  const globals = ${serializeForInlineScript(globals)};
  const applyTheme = (theme) => {
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  const emitGlobals = (next) => {
    Object.assign(window.openai, next);
    applyTheme(next.theme);
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: next } }));
  };
  const reportHeight = (height) => {
    const maxHeight = Math.max(240, Number(window.openai?.maxHeight) || 680);
    const nextHeight = Math.max(240, Math.min(maxHeight, Math.ceil(Number(height) || 0)));
    window.parent.postMessage({ source: 'codexui-mcp-app', type: 'height', widgetId, height: nextHeight }, '*');
  };
  const reportReady = () => {
    const root = document.getElementById('root');
    if (!root || root.childElementCount === 0) return;
    reportHeight(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    window.parent.postMessage({ source: 'codexui-mcp-app', type: 'ready', widgetId }, '*');
  };
  window.openai = {
    ...globals,
    setWidgetState(state) {
      this.widgetState = state;
      emitGlobals({ widgetState: state });
    },
    openExternal({ href }) {
      if (typeof href !== 'string' || !/^https?:\\/\\//i.test(href)) {
        return Promise.reject(new Error('Only HTTP(S) links are supported'));
      }
      window.open(href, '_blank', 'noopener,noreferrer');
      return Promise.resolve({});
    },
    callTool() {
      return Promise.reject(new Error('Interactive follow-up tool calls are not available in this host'));
    },
    sendFollowUpMessage() {
      return Promise.reject(new Error('Widget-authored messages are not available in this host'));
    },
    requestDisplayMode() {
      return Promise.resolve({ mode: 'inline' });
    },
    requestModal() {
      return Promise.reject(new Error('Widget modals are not available in this host'));
    },
    requestClose() {
      return Promise.resolve();
    },
    notifyIntrinsicHeight({ height } = {}) {
      reportHeight(height || document.documentElement.scrollHeight);
    },
    setOpenInAppUrl() {},
  };
  applyTheme(globals.theme);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== 'codexui-mcp-host' || data.widgetId !== widgetId) return;
    if (data.type === 'globals' && data.globals) emitGlobals(data.globals);
  });
  const installObservers = () => {
    reportReady();
    const observer = new MutationObserver(reportReady);
    observer.observe(document.body, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(reportReady);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installObservers, { once: true });
  } else {
    installObservers();
  }
})();
</${'script'}>`
}

function buildWidgetSrcdoc(
  html: string,
  meta: Record<string, unknown>,
): string {
  const headContent = [
    `<meta id="openai-runtime-config">`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta http-equiv="Content-Security-Policy" content="${buildWidgetCsp(meta).replace(/"/gu, '&quot;')}">`,
    createOpenAiBridgeScript(),
  ].join('')
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (openingHead) => `${openingHead}${headContent}`)
  }
  return `<!doctype html><html><head>${headContent}</head><body>${html}</body></html>`
}

async function loadWidgetResource(): Promise<void> {
  const version = ++resourceLoadVersion
  widgetReady.value = false
  showNativeView.value = false
  widgetSrcdoc.value = ''
  resourceError.value = ''
  isLoadingResource.value = true
  try {
    const resource = await readMcpAppResource(
      props.result.server,
      props.result.resourceUri,
      props.threadId,
    )
    if (version !== resourceLoadVersion) return
    if (!resource || !resource.mimeType.toLocaleLowerCase().includes('html')) {
      throw new Error('The app did not return an HTML view')
    }
    widgetSrcdoc.value = buildWidgetSrcdoc(resource.text, resource.meta)
  } catch (caught) {
    if (version !== resourceLoadVersion) return
    resourceError.value = caught instanceof Error ? caught.message : 'Unable to load the interactive view'
  } finally {
    if (version === resourceLoadVersion) isLoadingResource.value = false
  }
}

function onWidgetMessage(event: MessageEvent): void {
  if (event.source !== iframeRef.value?.contentWindow) return
  const data = asRecord(event.data)
  if (
    data?.source !== 'codexui-mcp-app'
    || data.widgetId !== widgetId
  ) return
  if (data.type === 'ready') {
    widgetReady.value = true
    return
  }
  if (data.type === 'height') {
    const height = readNumber(data.height)
    if (height !== null) {
      widgetHeight.value = Math.max(240, Math.min(widgetMaxHeight.value, Math.ceil(height)))
    }
  }
}

function sendHostGlobalsToWidget(): void {
  iframeRef.value?.contentWindow?.postMessage({
    source: 'codexui-mcp-host',
    type: 'globals',
    widgetId,
    globals: {
      theme: currentTheme(),
      maxHeight: widgetMaxHeight.value,
      maxWidth: widgetMaxWidth.value,
      surfaceBackgroundColor: currentSurfaceBackgroundColor(),
    },
  }, '*')
}

function updateWidgetViewport(): void {
  widgetMaxHeight.value = computeWidgetMaxHeight()
  widgetMaxWidth.value = iframeRef.value?.clientWidth || computeWidgetMaxWidth()
  widgetHeight.value = Math.min(widgetHeight.value, widgetMaxHeight.value)
  sendHostGlobalsToWidget()
}

watch(
  () => [
    props.result.server,
    props.result.resourceUri,
    props.result.structuredContent,
    props.result.resultMeta,
  ],
  () => void loadWidgetResource(),
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('message', onWidgetMessage)
  window.addEventListener('resize', updateWidgetViewport)
  window.visualViewport?.addEventListener('resize', updateWidgetViewport)
  themeObserver = new MutationObserver(sendHostGlobalsToWidget)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  updateWidgetViewport()
})

onBeforeUnmount(() => {
  resourceLoadVersion += 1
  window.removeEventListener('message', onWidgetMessage)
  window.removeEventListener('resize', updateWidgetViewport)
  window.visualViewport?.removeEventListener('resize', updateWidgetViewport)
  themeObserver?.disconnect()
  themeObserver = null
})
</script>

<style scoped>
@reference "tailwindcss";

.mcp-app-result {
  @apply w-full overflow-hidden rounded-xl border;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
}

.mcp-app-result-header {
  @apply flex min-w-0 items-center justify-between gap-3 border-b px-3 py-2.5;
  border-color: var(--border-soft);
}

.mcp-app-result-heading {
  @apply flex min-w-0 items-center gap-2;
}

.mcp-app-result-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--accent);
}

.mcp-app-result-title-wrap {
  @apply min-w-0;
}

.mcp-app-result-title {
  @apply m-0 truncate text-sm font-semibold;
  color: var(--text-primary);
}

.mcp-app-result-summary {
  @apply m-0 truncate text-xs;
  color: var(--text-tertiary);
}

.mcp-app-result-view-toggle {
  @apply shrink-0 rounded-md border px-2 py-1 text-xs font-medium transition;
  border-color: var(--border-soft);
  color: var(--text-secondary);
  background: var(--surface-muted);
}

.mcp-app-result-view-toggle:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.mcp-app-widget-shell {
  @apply relative w-full overflow-hidden;
  background: var(--surface-elevated);
}

.mcp-app-widget-frame {
  @apply block w-full border-0;
  background: var(--surface-elevated);
}

.mcp-app-widget-frame.is-hidden {
  @apply pointer-events-none absolute inset-0 opacity-0;
}

.mcp-app-native-results {
  @apply grid max-h-[38rem] grid-cols-1 gap-3 overflow-y-auto p-3 md:grid-cols-2;
}

.mcp-app-accommodation {
  @apply flex min-w-0 flex-col overflow-hidden rounded-xl border;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.mcp-app-flight {
  @apply flex min-w-0 flex-col gap-4 rounded-xl border p-3;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.mcp-app-flight-top,
.mcp-app-flight-footer {
  @apply flex min-w-0 items-center justify-between gap-3;
}

.mcp-app-flight-route {
  @apply flex min-w-0 items-center gap-2;
}

.mcp-app-flight-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--accent);
}

.mcp-app-flight-title,
.mcp-app-flight-airline,
.mcp-app-flight-footer p {
  @apply m-0;
}

.mcp-app-flight-title {
  @apply truncate text-sm font-semibold;
  color: var(--text-primary);
}

.mcp-app-flight-airline,
.mcp-app-flight-footer p {
  @apply text-xs;
  color: var(--text-tertiary);
}

.mcp-app-flight-times {
  @apply grid items-center gap-3;
  grid-template-columns: minmax(0, auto) minmax(4rem, 1fr) minmax(0, auto);
}

.mcp-app-flight-times > div:not(.mcp-app-flight-duration) {
  @apply flex flex-col;
}

.mcp-app-flight-times strong {
  @apply text-base;
  color: var(--text-primary);
}

.mcp-app-flight-times span {
  @apply text-xs;
  color: var(--text-tertiary);
}

.mcp-app-flight-duration {
  @apply flex min-w-0 flex-col items-center gap-1 text-center;
}

.mcp-app-flight-line {
  @apply h-px w-full;
  background: var(--border-strong);
}

.mcp-app-flight-arrival {
  @apply text-right;
}

.mcp-app-accommodation-photo,
.mcp-app-accommodation-photo-placeholder {
  @apply h-36 w-full object-cover;
}

.mcp-app-accommodation-photo-placeholder {
  @apply flex items-center justify-center;
  background: var(--surface-hover);
  color: var(--text-tertiary);
}

.mcp-app-accommodation-photo-placeholder > svg {
  @apply h-8 w-8;
}

.mcp-app-accommodation-body {
  @apply flex flex-1 flex-col gap-2 p-3;
}

.mcp-app-accommodation-title-row {
  @apply flex min-w-0 items-start justify-between gap-2;
}

.mcp-app-accommodation-name {
  @apply m-0 min-w-0 text-sm font-semibold leading-snug;
  color: var(--text-primary);
}

.mcp-app-accommodation-rating {
  @apply inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold;
  background: var(--accent-soft);
  color: var(--accent);
}

.mcp-app-accommodation-rating-icon {
  @apply h-3 w-3 fill-current;
}

.mcp-app-accommodation-location,
.mcp-app-accommodation-reviews {
  @apply m-0 text-xs;
  color: var(--text-tertiary);
}

.mcp-app-accommodation-facilities {
  @apply flex flex-wrap gap-1;
}

.mcp-app-accommodation-facilities > span {
  @apply rounded-full border px-1.5 py-0.5 text-[11px];
  border-color: var(--border-soft);
  color: var(--text-secondary);
  background: var(--surface-elevated);
}

.mcp-app-accommodation-footer {
  @apply mt-auto flex items-end justify-between gap-3 pt-1;
}

.mcp-app-accommodation-price {
  @apply m-0 text-sm font-semibold;
  color: var(--text-primary);
}

.mcp-app-accommodation-link {
  @apply inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold no-underline transition;
  background: var(--accent);
  color: white;
}

.mcp-app-accommodation-link:hover {
  background: var(--accent-strong);
  color: white;
}

.mcp-app-accommodation-link > svg {
  @apply h-3 w-3;
}

.mcp-app-result-placeholder {
  @apply px-3 py-6 text-center text-sm;
  color: var(--text-tertiary);
}

@media (max-width: 640px) {
  .mcp-app-result-header {
    @apply items-start;
  }

  .mcp-app-result-summary {
    @apply whitespace-normal;
  }

  .mcp-app-native-results {
    @apply max-h-none;
  }

  .mcp-app-flight-top,
  .mcp-app-flight-footer {
    @apply flex-wrap items-start;
  }

  .mcp-app-flight-times {
    @apply gap-2;
    grid-template-columns: minmax(0, auto) minmax(2.5rem, 1fr) minmax(0, auto);
  }

  .mcp-app-accommodation-footer {
    @apply flex-wrap items-start;
  }

  .mcp-app-accommodation-link {
    @apply whitespace-nowrap;
  }
}
</style>
