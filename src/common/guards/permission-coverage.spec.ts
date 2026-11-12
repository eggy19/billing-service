import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BILLING_PERMISSIONS } from '../constants/permissions';
import {
  PERMISSION_EXEMPT_KEY,
  REQUIRE_PERMISSION_KEY,
} from '../decorators/require-permission.decorator';

/**
 * Menyapu semua controller di src dan gagal bila ada handler publik tanpa
 * permission (atau permission di luar katalog / tidak sesuai EXPECTED).
 * Endpoint baru wajib ditambahkan ke EXPECTED (dan ke tabel spec §7.5).
 * Mapping = spec billing-mvp-spec §7.5; tiap nilai = daftar any-of.
 */
const SRC = resolve(__dirname, '../..');
const EXEMPT_CONTROLLERS = ['HealthController'];

// Belum ada endpoint bisnis di tahap scaffold; isi sesuai §7.5 saat modul ditambahkan.
const EXPECTED = new Map<string, string[]>([]);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

type Handler = { controller: string; key: string; fn: () => void };
type ControllerClass = (new () => object) & {
  prototype: Record<string, unknown>;
  name: string;
};

function loadControllers(): {
  classes: ControllerClass[];
  handlers: Handler[];
} {
  const classes: ControllerClass[] = [];
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exp of Object.values(mod)) {
      if (
        typeof exp === 'function' &&
        Reflect.hasMetadata(PATH_METADATA, exp)
      ) {
        classes.push(exp as ControllerClass);
      }
    }
  }
  const handlers: Handler[] = [];
  for (const cls of classes) {
    const base = String(Reflect.getMetadata(PATH_METADATA, cls));
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      const fn = cls.prototype[name] as () => void;
      if (typeof fn !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, fn))
        continue;
      const method =
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
      const subRaw = Reflect.getMetadata(PATH_METADATA, fn) as
        string | string[];
      for (const sub of Array.isArray(subRaw) ? subRaw : [subRaw]) {
        const path = [base, sub]
          .join('/')
          .replace(/\/+/g, '/')
          .replace(/^\/|\/$/g, '');
        handlers.push({ controller: cls.name, key: `${method} ${path}`, fn });
      }
    }
  }
  return { classes, handlers };
}

describe('permission coverage of all controllers (default-deny)', () => {
  const { classes, handlers } = loadControllers();
  const isExempt = (cls: ControllerClass): boolean =>
    Reflect.getMetadata(PERMISSION_EXEMPT_KEY, cls) === true;

  it('discovers the controllers (sanity)', () => {
    expect(classes.length).toBeGreaterThanOrEqual(1);
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });

  it('only /health and /billing/internal controllers are exempt', () => {
    expect(
      classes
        .filter(isExempt)
        .map((c) => c.name)
        .sort(),
    ).toEqual([...EXEMPT_CONTROLLERS].sort());
  });

  const publicHandlers = handlers.filter(
    (h) => !EXEMPT_CONTROLLERS.includes(h.controller),
  );

  it('has no public handler without a declared catalog permission', () => {
    const offenders = publicHandlers.filter((h) => {
      const perms = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, h.fn) as
        string[] | undefined;
      return (
        !perms ||
        perms.length === 0 ||
        !perms.every((p) =>
          (BILLING_PERMISSIONS as readonly string[]).includes(p),
        ) ||
        JSON.stringify(EXPECTED.get(h.key)) !== JSON.stringify(perms)
      );
    });
    expect(offenders.map((h) => h.key)).toEqual([]);
  });

  it('EXPECTED mapping has no stale entries', () => {
    const keys = new Set(publicHandlers.map((h) => h.key));
    expect([...EXPECTED.keys()].filter((k) => !keys.has(k))).toEqual([]);
  });

  it('exempt controllers declare no user permission', () => {
    for (const h of handlers.filter((x) =>
      EXEMPT_CONTROLLERS.includes(x.controller),
    )) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, h.fn)).toBeUndefined();
    }
  });
});
