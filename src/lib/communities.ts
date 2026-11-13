import type { Env } from '../types';
import { hashTrackedFields } from './excel-sync';
import { slugify } from './http';

export interface CommunityRow {
  id: number;
  submission_id: number | null;
  source_key: string | null;
  name: string;
  slug: string;
  region: string | null;
  location_text: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string;
  energy_initiative_details: string;
  proposals_tags: string | null;
  junte_energetico: 0 | 1 | null;
  website_url: string | null;
  private_contact_email: string | null;
  private_comments: string | null;
  is_visible: 0 | 1;
  show_name: 0 | 1;
  show_location: 0 | 1;
  show_on_map: 0 | 1;
  show_description: 0 | 1;
  show_energy_initiative_details: 0 | 1;
  show_website_url: 0 | 1;
  show_contact_email: 0 | 1;
  sync_source: 'web' | 'excel' | 'seed';
  source_sheet: string | null;
  last_synced_excel_hash: string | null;
  current_db_hash: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * The ONLY shape of a community that leaves the server on public endpoints.
 * It is built field by field (an allow-list), so a new private column can never
 * leak by accident, and every field whose show_* toggle is 0 is returned as null.
 */
export function publicCommunity(c: CommunityRow) {
  const showLocation = c.show_location === 1;
  const showCoordinates = showLocation && c.show_on_map === 1 && c.latitude !== null && c.longitude !== null;
  return {
    // The slug is derived from the name, so a hidden name gets a neutral identifier.
    slug: c.show_name === 1 ? c.slug : `comunidad-${c.id}`,
    name: c.show_name === 1 ? c.name : null,
    region: c.region,
    location_text: showLocation ? c.location_text : null,
    country: showLocation ? c.country : null,
    latitude: showCoordinates ? c.latitude : null,
    longitude: showCoordinates ? c.longitude : null,
    description: c.show_description === 1 ? c.description : null,
    energy_initiative_details: c.show_energy_initiative_details === 1 ? c.energy_initiative_details : null,
    tags: c.proposals_tags ? c.proposals_tags.split(';').map((t) => t.trim()).filter(Boolean) : [],
    junte_energetico: c.junte_energetico === null ? null : c.junte_energetico === 1,
    website_url: c.show_website_url === 1 ? c.website_url : null,
    contact_email: c.show_contact_email === 1 ? c.private_contact_email : null,
  };
}

/** Hash of the DB record over the same fields (and order) used for Excel rows. */
export function communityDbHash(c: Pick<CommunityRow, 'name' | 'location_text' | 'country' | 'latitude' | 'longitude' | 'description' | 'energy_initiative_details' | 'proposals_tags' | 'junte_energetico' | 'website_url' | 'private_contact_email' | 'private_comments'>): Promise<string> {
  return hashTrackedFields({
    name: c.name,
    location_text: c.location_text,
    country: c.country,
    latitude: c.latitude,
    longitude: c.longitude,
    description: c.description,
    energy_initiative_details: c.energy_initiative_details,
    proposals_tags: c.proposals_tags,
    junte_energetico: c.junte_energetico,
    website_url: c.website_url,
    contact_email: c.private_contact_email,
    comments: c.private_comments,
  });
}

/** A slug not used by any community (including soft-deleted ones: the column is UNIQUE). */
export async function uniqueSlug(env: Env, name: string, taken: Set<string> = new Set()): Promise<string> {
  const base = slugify(name);
  // Not LIKE: D1 rejects LIKE patterns longer than 50 bytes, and names can be longer than that.
  const { results } = await env.DB.prepare("SELECT slug FROM communities WHERE slug = ?1 OR substr(slug, 1, length(?1) + 1) = ?1 || '-'").bind(base).all<{ slug: string }>();
  const used = new Set([...results.map((r) => r.slug), ...taken]);
  let slug = base;
  for (let n = 2; used.has(slug) || /^comunidad-\d+$/.test(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}
