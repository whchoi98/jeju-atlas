import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Catalog } from '../server/catalog.mjs';
import { catalogPlaceInfo } from '../server/guide-facts.mjs';

const defaultPath = fileURLToPath(new URL('../.local/reference-catalog.sqlite', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const ordered = (map) => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const noncommercial = (license) => ['KOGL-2', 'KOGL-4'].includes(license)
  || (typeof license === 'string' && /^CC(?:[- ]|$).*[- ]NC(?:[- ]|$)/i.test(license));
const legacyTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);

/**
 * Audit a local snapshot only. No AWS client, credential lookup, model call,
 * output file, temporary database, or source mutation is involved.
 * Counts and key order depend only on the snapshot and adapter implementation.
 */
export async function auditCatalog(localPath = defaultPath) {
  const path = resolve(localPath);
  const initial = await stat(path);
  if (!initial.isFile() || initial.size > 32 * 1024 * 1024) throw new Error('Invalid catalog file size');
  const sha256 = digest(await readFile(path));
  const catalog = new Catalog({ localPath: path, clock: () => 0 });
  let db;
  try {
    await catalog.init();
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all()
      .map(({ key, value }) => [key, value]));
    const hasExtra = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'place_extra'").get());
    const rows = db.prepare(hasExtra
      ? 'SELECT p.id, e.photos FROM places p LEFT JOIN place_extra e ON e.id = p.id ORDER BY p.id'
      : 'SELECT id, NULL AS photos FROM places ORDER BY id').all();
    const status = catalog.status();
    const licenseEntries = new Map();
    const licensePlaces = new Map();
    const servedLicenses = new Map();
    const states = new Map();
    const sourceEntries = new Map();
    const sourcePlaces = new Map();
    const scheduleSources = new Map();
    const registrations = new Map();
    const report = {
      snapshot: { sha256, bytes: initial.size, schema_version: meta.schema_version, built_at: status.built_at },
      places: { total: status.total, by_source: status.by_source, categories: status.categories },
      photos: {
        raw_entries: 0, raw_places: 0, served_entries: 0, served_places: status.photos_count,
        blocked_entries: 0, noncommercial_entries: 0, noncommercial_places: 0,
        served_noncommercial_entries: 0, missing_credit_entries: 0, missing_origin_entries: 0,
        malformed_photo_rows: 0, no_derivatives_entries: 0,
        raw_no_derivatives_thumbnails: 0, served_no_derivatives_thumbnails: 0, by_license: {},
      },
      provenance: {
        reviewed_places: 0, non_reviewed_places: 0, reviewed_fields: 0, field_states: {},
        curated_places: 0, curated_only_enrichment_places: 0, curated_mixed_enrichment_places: 0,
        legacy_source_timestamps: 0, preserved_legacy_source_timestamps: 0,
        source_timestamps_dropped_by_guide: 0, enrichment_sources: {},
      },
      schedules: {
        places_with_weekly_hours: 0, parsed_places: 0,
        identical_seven_day_schedules: 0, places_with_base_hours: 0, by_source: {},
      },
      facilities: { no_fields_places: 0, all_unknown_places: 0, any_known_value_places: 0 },
      registrations: { by_status: {}, places_with_registration_note: 0 },
    };
    let actualPhotoPlaces = 0;
    for (const raw of rows) {
      const place = catalog.detail(raw.id);
      const guide = catalogPlaceInfo(place);
      let rawPhotos = [];
      if (raw.photos) {
        try {
          const decoded = JSON.parse(raw.photos);
          if (Array.isArray(decoded)) rawPhotos = decoded;
          else report.photos.malformed_photo_rows++;
        } catch {
          report.photos.malformed_photo_rows++;
        }
      }
      if (rawPhotos.length) report.photos.raw_places++;
      report.photos.raw_entries += rawPhotos.length;
      const placeLicenses = new Set();
      let hasNoncommercial = false;
      for (const photo of rawPhotos) {
        const license = typeof photo?.license === 'string' && photo.license ? photo.license : '(missing)';
        increment(licenseEntries, license);
        placeLicenses.add(license);
        if (noncommercial(license)) {
          hasNoncommercial = true;
          report.photos.noncommercial_entries++;
        }
        if (typeof photo?.credit !== 'string' || !photo.credit.trim()) report.photos.missing_credit_entries++;
        if (typeof photo?.origin_url !== 'string' || !photo.origin_url.trim()) report.photos.missing_origin_entries++;
        if (['KOGL-3', 'KOGL-4'].includes(license)) {
          report.photos.no_derivatives_entries++;
          if (photo.thumb_url != null) report.photos.raw_no_derivatives_thumbnails++;
        }
      }
      if (hasNoncommercial) report.photos.noncommercial_places++;
      for (const license of placeLicenses) increment(licensePlaces, license);
      if (place.photos.length) actualPhotoPlaces++;
      for (const photo of place.photos) {
        report.photos.served_entries++;
        increment(servedLicenses, photo.license);
        if (noncommercial(photo.license)) report.photos.served_noncommercial_entries++;
        if (['KOGL-3', 'KOGL-4'].includes(photo.license) && photo.thumb_url !== null) {
          report.photos.served_no_derivatives_thumbnails++;
        }
      }
      let reviewed = false;
      for (const item of Object.values(place.field_evidence ?? {})) {
        increment(states, item.state);
        if (item.state === 'reviewed') {
          reviewed = true;
          report.provenance.reviewed_fields++;
        }
      }
      report.provenance[reviewed ? 'reviewed_places' : 'non_reviewed_places']++;
      const providers = new Set(place.sources.map(source => source.source));
      if (place.source === 'sample') {
        report.provenance.curated_places++;
        if (providers.size === 1 && providers.has('curated')) report.provenance.curated_only_enrichment_places++;
        if (providers.size > 1) report.provenance.curated_mixed_enrichment_places++;
      }
      for (const provider of providers) increment(sourcePlaces, provider);
      for (const source of place.sources) {
        increment(sourceEntries, source.source);
        const preserved = guide.sources.some(item => item.source === source.source && item.observed_at === source.observed_at);
        if (source.observed_at && !preserved) report.provenance.source_timestamps_dropped_by_guide++;
        if (legacyTime(source.observed_at)) {
          report.provenance.legacy_source_timestamps++;
          if (preserved) report.provenance.preserved_legacy_source_timestamps++;
        }
      }
      if (place.hours) report.schedules.places_with_base_hours++;
      if (place.hours_week.length) {
        report.schedules.places_with_weekly_hours++;
        increment(scheduleSources, place.hours_source ?? '(missing)');
        if (place.field_evidence?.hours_week?.state === 'parsed') report.schedules.parsed_places++;
        const times = new Set(place.hours_week.map(hour => `${hour.open}/${hour.close}`));
        const days = new Set(place.hours_week.map(hour => hour.day));
        if (place.hours_week.length === 7 && days.size === 7 && times.size === 1) {
          report.schedules.identical_seven_day_schedules++;
        }
      }
      const flags = Object.values(place.facilities);
      if (!flags.length) report.facilities.no_fields_places++;
      else if (flags.every(value => value === 'unknown')) report.facilities.all_unknown_places++;
      if (flags.some(value => ['yes', 'no', 'limited'].includes(value))) report.facilities.any_known_value_places++;
      increment(registrations, place.business_status ?? '(missing)');
      if (place.registration_note) report.registrations.places_with_registration_note++;
    }
    if (actualPhotoPlaces !== report.photos.served_places) throw new Error('Photo availability disagrees with served details');
    report.photos.blocked_entries = report.photos.raw_entries - report.photos.served_entries;
    report.photos.by_license = ordered(new Map([...licenseEntries].map(([license, entries]) => [
      license, { entries, places: licensePlaces.get(license), served_entries: servedLicenses.get(license) ?? 0 },
    ])));
    report.provenance.field_states = ordered(states);
    report.provenance.enrichment_sources = ordered(new Map([...sourceEntries].map(([source, entries]) => [
      source, { entries, places: sourcePlaces.get(source) },
    ])));
    report.schedules.by_source = ordered(scheduleSources);
    report.registrations.by_status = ordered(registrations);
    const final = await stat(path);
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.mtimeMs !== initial.mtimeMs
      || digest(await readFile(path)) !== sha256) throw new Error('Snapshot changed during audit');
    return report;
  } finally {
    db?.close();
    catalog.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/audit-catalog.mjs [local-catalog.sqlite]\nPrints deterministic JSON; defaults to .local/reference-catalog.sqlite. Never writes the source.');
  } else if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('Usage: node scripts/audit-catalog.mjs [local-catalog.sqlite]');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await auditCatalog(args[0]), null, 2));
    } catch (error) {
      console.error(`Catalog audit failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
