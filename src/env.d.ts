/// <reference types="vite/client" />

import type { Map } from 'maplibre-gl';

declare global {
  interface Window {
    /** Live MapLibre map, exposed for the parent's production browser checks. */
    __JEJU_MAP__?: Map;
  }
}

export {};
