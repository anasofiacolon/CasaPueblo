import { beforeAll, describe, expect, it } from 'vitest';
import { createAdmin, db, loginCookie, request } from './helpers';

let cookie: string;
beforeAll(async () => {
  await createAdmin('privacy-admin');
  cookie = await loginCookie('privacy-admin');
});

const base = {
  community_name: 'Comunidad Reservada',
  description: 'Descripción pública.',
  energy_initiative_details: 'Detalles de la iniciativa.',
  submitter_email: 'persona@privado.example',
  submitter_comments: 'Comentario interno muy privado',
};

async function submit(extra: Record<string, unknown> = {}): Promise<number> {
  const res = await request('/api/submissions', { json: { ...base, ...extra } });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).id;
}

async function approve(id: number): Promise<any> {
  const res = await request(`/api/admin/submissions/${id}/approve`, { json: {}, cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).community;
}

const publicList = async () => ((await (await request('/api/communities')).json()) as any).communities as any[];

describe('public submissions', () => {
  it('accepts a submission without any location and stores NULLs', async () => {
    const id = await submit({ community_name: 'Sin Ubicación', location_text: '' });
    const row = await db().prepare('SELECT location_text, latitude, longitude, show_location, show_submitter_email, status FROM submissions WHERE id = ?').bind(id).first();
    expect(row).toEqual({ location_text: null, latitude: null, longitude: null, show_location: 0, show_submitter_email: 0, status: 'pending' });
  });

  it('does not echo submitted data back to the public', async () => {
    const res = await request('/api/submissions', { json: base });
    expect(await res.json()).toEqual({ ok: true, id: expect.any(Number), status: 'pending' });
  });

  it('validates required fields, email and coordinate pairs', async () => {
    const bad: Record<string, unknown>[] = [
      { community_name: '' },
      { description: '   ' },
      { energy_initiative_details: undefined },
      { submitter_email: 'not-an-email' },
      { latitude: 18.2 },
      { longitude: -66.7 },
      { latitude: 0, longitude: 0 },
      { latitude: 91, longitude: 10 },
      { latitude: 'abc', longitude: 10 },
      { show_location: 'yes' },
    ];
    for (const extra of bad) {
      const res = await request('/api/submissions', { json: { ...base, ...extra } });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('the database itself refuses half coordinates and (0, 0)', async () => {
    const insert = (lat: number | null, lng: number | null) =>
      db().prepare("INSERT INTO submissions (community_name, description, energy_initiative_details, submitter_email, latitude, longitude) VALUES ('x', 'x', 'x', 'x@x.co', ?, ?)").bind(lat, lng).run();
    await expect(insert(18, null)).rejects.toThrow();
    await expect(insert(0, 0)).rejects.toThrow();
    await expect(insert(95, 10)).rejects.toThrow();
    await expect(insert(null, null)).resolves.toBeTruthy();
  });

  it('pending and rejected submissions never appear publicly', async () => {
    const pending = await submit({ community_name: 'Solo Pendiente' });
    const rejected = await submit({ community_name: 'Será Rechazada' });
    expect((await request(`/api/admin/submissions/${rejected}/reject`, { json: { comment: 'Fuera de alcance' }, cookie })).status).toBe(200);
    const names = (await publicList()).map((c) => c.name);
    expect(names).not.toContain('Solo Pendiente');
    expect(names).not.toContain('Será Rechazada');
    expect(pending).toBeGreaterThan(0);
    // A reviewed submission cannot be decided twice.
    expect((await request(`/api/admin/submissions/${rejected}/approve`, { json: {}, cookie })).status).toBe(409);
  });
});

describe('public serializer', () => {
  it('hides location and contact by default after approval', async () => {
    const community = await approve(await submit({ community_name: 'Valores Por Defecto', location_text: 'Barrio Secreto, Adjuntas', latitude: 18.16, longitude: -66.72 }));
    const c = (await publicList()).find((x) => x.slug === community.slug);
    expect(c).toMatchObject({ name: 'Valores Por Defecto', description: base.description, location_text: null, country: null, latitude: null, longitude: null, contact_email: null });

    const single = await (await request(`/api/communities/${community.slug}`)).text();
    for (const secret of ['Barrio Secreto', '18.16', '-66.72', 'persona@privado.example', 'Comentario interno']) {
      expect(single, secret).not.toContain(secret);
    }
  });

  it('publishes exactly the fields the submitter authorized', async () => {
    const community = await approve(
      await submit({ community_name: 'Todo Autorizado', location_text: 'Adjuntas, Puerto Rico', latitude: 18.16, longitude: -66.72, show_location: true, show_submitter_email: true }),
    );
    const c = (await publicList()).find((x) => x.slug === community.slug);
    expect(c).toMatchObject({ location_text: 'Adjuntas, Puerto Rico', latitude: 18.16, longitude: -66.72, contact_email: 'persona@privado.example' });
  });

  it('nulls each field whose toggle is off, and only that field', async () => {
    const community = await approve(await submit({ community_name: 'Parcial', show_description: false, show_energy_initiative_details: false }));
    const c = (await publicList()).find((x) => x.slug === community.slug);
    expect(c.name).toBe('Parcial');
    expect(c.description).toBeNull();
    expect(c.energy_initiative_details).toBeNull();
  });

  it('a hidden name also hides the name-derived slug', async () => {
    const community = await approve(await submit({ community_name: 'Nombre Súper Secreto', show_community_name: false }));
    const text = JSON.stringify(await publicList());
    expect(text).not.toContain('Nombre Súper Secreto');
    expect(text).not.toContain(community.slug);
    expect((await request(`/api/communities/${community.slug}`)).status).toBe(404);
    const neutral = await request(`/api/communities/comunidad-${community.id}`);
    expect(neutral.status).toBe(200);
    expect(((await neutral.json()) as any).community.name).toBeNull();
  });

  it('only ever exposes the allow-listed keys', async () => {
    const allowed = ['slug', 'name', 'region', 'location_text', 'country', 'latitude', 'longitude', 'description', 'energy_initiative_details', 'tags', 'junte_energetico', 'website_url', 'contact_email'];
    for (const c of await publicList()) expect(Object.keys(c).sort()).toEqual([...allowed].sort());
    const text = JSON.stringify(await publicList());
    for (const leak of ['private_', 'hash', 'submission_id', 'admin_id', 'show_', 'Comentario interno']) expect(text, leak).not.toContain(leak);
  });

  it('show_on_map alone does not reveal coordinates when the location is hidden', async () => {
    const res = await request('/api/admin/communities', {
      json: { name: 'Mapa Sin Permiso', description: 'd', energy_initiative_details: 'e', latitude: 10.5, longitude: -70.5, show_on_map: true, show_location: false },
      cookie,
    });
    expect(res.status).toBe(201);
    const c = (await publicList()).find((x) => x.name === 'Mapa Sin Permiso');
    expect(c.latitude).toBeNull();
    expect(c.longitude).toBeNull();
  });

  it('hidden and deleted communities disappear from the public API', async () => {
    const created = ((await (await request('/api/admin/communities', { json: { name: 'Temporal', description: 'd', energy_initiative_details: 'e' }, cookie })).json()) as any).community;
    expect((await request(`/api/communities/${created.slug}`)).status).toBe(200);

    await request(`/api/admin/communities/${created.id}`, { method: 'PUT', json: { is_visible: false }, cookie });
    expect((await request(`/api/communities/${created.slug}`)).status).toBe(404);

    await request(`/api/admin/communities/${created.id}`, { method: 'PUT', json: { is_visible: true }, cookie });
    expect((await request(`/api/admin/communities/${created.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await request(`/api/communities/${created.slug}`)).status).toBe(404);
    expect((await publicList()).map((c) => c.name)).not.toContain('Temporal');
  });

  it('handles long names and gives repeated names distinct slugs', async () => {
    const name = 'Asociación Comunitaria de Energía Renovable y Solar del Barrio de Ejemplo (ACERSBE)';
    const slugs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request('/api/admin/communities', { json: { name, description: 'd', energy_initiative_details: 'e' }, cookie });
      expect(res.status).toBe(201);
      slugs.push(((await res.json()) as any).community.slug);
    }
    const base = 'asociacion-comunitaria-de-energia-renovable-y-solar-del-barrio-de-ejemplo-acersbe';
    expect(slugs).toEqual([base, `${base}-2`, `${base}-3`]);
    // The search box in the admin portal must also accept long text.
    expect((await request(`/api/admin/submissions?q=${encodeURIComponent(name)}`, { cookie })).status).toBe(200);
  });

  it('new communities created by an admin keep location and contact hidden by default', async () => {
    const created = ((await (await request('/api/admin/communities', {
      json: { name: 'Nueva Admin', description: 'd', energy_initiative_details: 'e', location_text: 'Lugar', private_contact_email: 'a@b.co' },
      cookie,
    })).json()) as any).community;
    expect(created).toMatchObject({ show_location: 0, show_on_map: 0, show_contact_email: 0, latitude: null, longitude: null });
  });
});

describe('seed data', () => {
  it('contains the six workbook communities and the project information sections', async () => {
    const { results } = await db().prepare("SELECT name FROM communities WHERE sync_source = 'seed' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['Abeyno Coop', 'Casa Pueblo', 'Colectivo Ecologista Madreselva', 'Comunidad Toro Negro', 'Fundación Kara Solar', 'Unión de Cooperativas Tosepan']);
    const sections = ((await (await request('/api/project-info')).json()) as any).sections;
    expect(sections.map((s: any) => s.section_key)).toEqual(['what_is', 'scope', 'vision', 'purpose', 'categories', 'guiding_principles']);
    for (const s of sections) expect(() => JSON.parse(s.content)).not.toThrow();
  });
});
