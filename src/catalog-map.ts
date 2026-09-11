import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapStyleImageMissingEvent } from 'maplibre-gl';
import type { GuideMap } from '../shared/api-types';
import type { RouteSuccess } from '../shared/routing-types';
import type { TripStop } from './trip';
import { isJejuPoint } from './api';
import { categorySymbol, paintIcon, type IconName } from './icons';

export type CatalogPoints = GeoJSON.FeatureCollection<GeoJSON.Point, {
  id: string; name: string; category: string; source_label: string;
}>;
const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700;
const osmCredit = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors · ODbL</a>';

export class CatalogMap {
  private selected: { id: string; name: string; lng: number; lat: number; category: string } | null = null;
  private hovered: { name: string; lng: number; lat: number } | null = null;
  private label: HTMLDivElement;

  constructor(readonly map: MapLibreMap, onSelect: (id: string) => void) {
    // All result pictograms and labels use local sprites. Only one bounded DOM
    // label follows the hovered/selected point; the catalog stays GPU rendered.
    map.on('styleimagemissing', this.missingImage);
    this.label = document.createElement('div');
    this.label.className = 'catalog-map-label';
    this.label.setAttribute('role', 'tooltip');
    this.label.hidden = true;
    map.getContainer().append(this.label);
    map.on('move', this.updateLabel);
    map.on('remove', () => this.label.remove());
    map.addSource('catalog-points', {
      type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 14, clusterRadius: 58,
      clusterMinPoints: 3, attribution: osmCredit,
    });
    map.addLayer({
      id: 'catalog-clusters', type: 'symbol', source: 'catalog-points', filter: ['has', 'point_count'],
      layout: {
        visibility: 'none',
        'icon-image': ['concat', 'atlas-cluster-pin-', ['to-string', ['get', 'point_count']]],
        'icon-allow-overlap': false, 'icon-padding': 5,
      },
    });
    map.addLayer({
      id: 'catalog-dots', type: 'symbol', source: 'catalog-points', filter: ['!', ['has', 'point_count']],
      layout: {
        visibility: 'none',
        'icon-image': ['concat', 'atlas-category-', ['get', 'category_icon']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 14, 1, 17, 1.1],
        'icon-allow-overlap': false, 'icon-padding': 6,
      },
    });
    map.addLayer({
      id: 'catalog-place-labels', type: 'symbol', source: 'catalog-points', minzoom: 14,
      filter: ['!', ['has', 'point_count']],
      layout: {
        visibility: 'none', 'icon-image': ['get', 'name_sprite'],
        'icon-offset': [0, 25], 'icon-allow-overlap': false, 'icon-padding': 5,
      },
    });
    this.routeLayer('trip', '#a85d00');
    this.routeLayer('guide', '#6842b3');
    map.addSource('catalog-selection', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'catalog-selected-marker', type: 'symbol', source: 'catalog-selection',
      layout: {
        'icon-image': ['concat', 'atlas-selected-', ['get', 'category_icon']],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    const select = (event: MapLayerMouseEvent) => {
      if (map.getContainer().closest('.is-measuring')) return;
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === 'string') onSelect(id);
    };
    map.on('click', 'catalog-dots', select);
    map.on('click', 'catalog-selected-marker', select);
    map.on('click', 'trip-stops', select);
    map.on('click', 'guide-stops', select);
    map.on('click', 'catalog-clusters', async (event) => {
      if (map.getContainer().closest('.is-measuring')) return;
      const feature = event.features?.[0];
      if (feature?.geometry.type !== 'Point') return;
      const source = map.getSource('catalog-points') as GeoJSONSource;
      try {
        const zoom = await source.getClusterExpansionZoom(Number(feature.properties.cluster_id));
        if (map.getContainer().closest('.is-measuring')) return;
        map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: Math.min(17, zoom), duration: motion() });
      } catch { /* A newer point request may replace a cluster before the click resolves. */ }
    });
    for (const layer of ['catalog-clusters', 'catalog-dots', 'catalog-selected-marker', 'trip-stops', 'guide-stops']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
        this.hovered = null;
        this.updateLabel();
      });
    }
    for (const layer of ['catalog-dots', 'catalog-selected-marker', 'trip-stops', 'guide-stops']) {
      map.on('mousemove', layer, (event) => {
        const feature = event.features?.[0];
        if (feature?.geometry.type !== 'Point' || typeof feature.properties.name !== 'string') return;
        this.hovered = { name: feature.properties.name, lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] };
        this.updateLabel();
      });
    }
  }

  private missingImage = (event: MapStyleImageMissingEvent): void => {
    if (this.map.hasImage(event.id)) return;
    const nameMatch = /^atlas-name-(.+)$/.exec(event.id);
    if (nameMatch) {
      let name: string;
      try { name = decodeURIComponent(nameMatch[1]).slice(0, 42); } catch { return; }
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      context.font = '500 22px "NanumSquare", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      canvas.width = Math.min(480, Math.ceil(context.measureText(name).width) + 24);
      canvas.height = 42;
      context.font = '500 22px "NanumSquare", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      context.fillStyle = '#fffffff2';
      context.beginPath(); context.roundRect(0, 0, canvas.width, 42, 7); context.fill();
      context.fillStyle = '#232f3e'; context.textBaseline = 'middle'; context.textAlign = 'center';
      context.fillText(name, canvas.width / 2, 21, canvas.width - 20);
      this.map.addImage(event.id, context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: 2 });
      return;
    }
    const categoryMatch = /^atlas-(category|selected|cluster)-(coast|mountain|cafe|food|museum|market|parking|trail|lodging|island|pin)(?:-(\d{1,5}))?$/.exec(event.id);
    if (categoryMatch) {
      const selected = categoryMatch[1] === 'selected';
      const cluster = categoryMatch[1] === 'cluster';
      const key = categoryMatch[2] as IconName;
      const color = categorySymbol(key).color;
      const canvas = document.createElement('canvas');
      canvas.width = cluster ? 96 : selected ? 80 : 64;
      canvas.height = cluster ? 88 : selected ? 80 : 64;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.scale(2, 2);
      const center = cluster ? 19 : selected ? 20 : 16;
      const radius = selected ? 17 : 14;
      context.fillStyle = selected ? '#0972d3' : '#ffffff';
      context.strokeStyle = selected ? '#ffffff' : color;
      context.lineWidth = selected ? 2.5 : 1.25;
      context.beginPath(); context.arc(center, center, radius, 0, Math.PI * 2); context.fill(); context.stroke();
      context.save(); context.translate(center - 9, center - 9); context.scale(.75, .75);
      context.strokeStyle = selected ? '#ffffff' : color; context.lineWidth = 1.8;
      context.lineCap = 'round'; context.lineJoin = 'round'; paintIcon(context, key); context.restore();
      if (cluster) {
        const count = categoryMatch[3] ?? '';
        context.font = '700 9px "NanumSquare", sans-serif';
        const width = Math.max(17, context.measureText(count).width + 8);
        context.fillStyle = color; context.strokeStyle = '#ffffff'; context.lineWidth = 1;
        context.beginPath(); context.roundRect(14, 27, width, 14, 6); context.fill(); context.stroke();
        context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillText(count, 14 + width / 2, 34);
      }
      this.map.addImage(event.id, context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: 2 });
      return;
    }
    if (!/^atlas-(count|stop)-\d{1,5}$/.test(event.id)) return;
    const label = event.id.split('-').at(-1)!;
    const canvas = document.createElement('canvas');
    canvas.width = 112;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '700 24px "NanumSquare", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillText(label, 56, 20);
    this.map.addImage(event.id, context.getImageData(0, 0, 112, 40), { pixelRatio: 2 });
  };

  private updateLabel = (): void => {
    const point = this.hovered ?? this.selected;
    if (!point) { this.label.hidden = true; return; }
    const screen = this.map.project([point.lng, point.lat]);
    const container = this.map.getContainer();
    this.label.hidden = screen.x < 0 || screen.x > container.clientWidth || screen.y < 0 || screen.y > container.clientHeight;
    this.label.textContent = point.name;
    this.label.style.left = `${Math.min(container.clientWidth - 80, Math.max(80, screen.x))}px`;
    this.label.style.top = `${Math.max(35, screen.y - 24)}px`;
  };

  private routeLayer(kind: 'trip' | 'guide', color: string): void {
    this.map.addSource(`${kind}-route`, { type: 'geojson', data: empty() });
    this.map.addLayer({
      id: `${kind}-route-line`, type: 'line', source: `${kind}-route`,
      paint: { 'line-color': color, 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
      layout: { 'line-join': 'round', 'line-cap': 'round' },
    });
    this.map.addSource(`${kind}-places`, { type: 'geojson', data: empty() });
    this.map.addLayer({
      id: `${kind}-stops`, type: 'circle', source: `${kind}-places`,
      paint: { 'circle-color': color, 'circle-radius': 12, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    this.map.addLayer({
      id: `${kind}-numbers`, type: 'symbol', source: `${kind}-places`,
      layout: { 'icon-image': ['concat', 'atlas-stop-', ['to-string', ['get', 'order']]], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    });
  }

  setPoints(data: CatalogPoints): void {
    this.hovered = null;
    this.updateLabel();
    const features = data.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties, category_icon: categorySymbol(feature.properties.category).icon,
        name_sprite: `atlas-name-${encodeURIComponent(feature.properties.name.slice(0, 42))}`,
      },
    }));
    const kinds = new Set(features.map((feature) => feature.properties.category_icon));
    const clusterIcon = kinds.size === 1 ? [...kinds][0] : 'pin';
    this.map.setLayoutProperty('catalog-clusters', 'icon-image', ['concat', `atlas-cluster-${clusterIcon}-`, ['to-string', ['get', 'point_count']]]);
    (this.map.getSource('catalog-points') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  setVisible(visible: boolean): void {
    for (const id of ['catalog-clusters', 'catalog-dots', 'catalog-place-labels']) {
      this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    if (!visible) { this.hovered = null; this.updateLabel(); }
  }

  setSelection(place: { id: string; name: string; lng: number; lat: number; category: string } | null): void {
    this.selected = place;
    (this.map.getSource('catalog-selection') as GeoJSONSource).setData(place ? {
      type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
        properties: { id: place.id, name: place.name, category_icon: categorySymbol(place.category).icon },
      }],
    } : empty());
    this.updateLabel();
  }

  private setRoute(kind: 'trip' | 'guide', places: { id: string; name: string; lat: number; lng: number }[], route: [number, number][]): void {
    (this.map.getSource(`${kind}-places`) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: places.map((place, index) => ({
        type: 'Feature', properties: { id: place.id, name: place.name, order: index + 1 },
        geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      })),
    });
    (this.map.getSource(`${kind}-route`) as GeoJSONSource).setData(route.length < 2 ? empty() : {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route } }],
    });
  }

  setTrip(stops: TripStop[], route: RouteSuccess | null = null): void {
    const coordinates = route && route.coordinates.length <= 30_000
      && route.coordinates.every(([lng, lat]) => isJejuPoint(lng, lat)) ? route.coordinates : [];
    this.setRoute('trip', stops, coordinates);
    // Keep white stop numbers legible and walking/driving routes distinct.
    const color = route?.mode === 'walk' ? '#0972d3' : '#a85d00';
    this.map.setPaintProperty('trip-route-line', 'line-color', color);
    this.map.setPaintProperty('trip-route-line', 'line-width', 4);
    this.map.setPaintProperty('trip-route-line', 'line-dasharray', route?.mode === 'walk' ? [1.5, 1] : [1, 0]);
    this.map.setPaintProperty('trip-stops', 'circle-color', color);
  }

  setGuide(response: GuideMap): void {
    const markers = response.markers.filter((point) => isJejuPoint(point.lng, point.lat)).slice(0, 40);
    const route = response.route.filter((point) => isJejuPoint(point.lng, point.lat)).slice(0, 512).map((point): [number, number] => [point.lng, point.lat]);
    this.setRoute('guide', markers, route);
    if (response.center && isJejuPoint(response.center.lng, response.center.lat)) {
      this.map.flyTo({
        center: [response.center.lng, response.center.lat],
        zoom: Math.max(8, Math.min(15, Number.isFinite(response.zoom) ? response.zoom : 11)),
        duration: motion(),
      });
    }
  }
}
