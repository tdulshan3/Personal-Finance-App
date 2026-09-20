/**
 * Endpoint and transport controls for the inference clients.
 *
 * buildspec.md §18 "Endpoint and transport controls": "The endpoint client is not a generic
 * URL-fetch tool. Restrict scheme, approved host/port, allowed API paths, redirect behavior,
 * response size, connection/read timeouts, and proxy authentication. Resolve and validate
 * destinations on connection, prevent redirects/DNS changes to unapproved destinations, and reject
 * metadata/link-local targets. Private LAN addresses are legitimate only when the owner explicitly
 * configured them. The agent cannot change this allowlist or pass a new URL through tool
 * arguments."
 *
 * Everything in the top half of this file is pure: `assertEndpointAllowed` never touches the
 * network, so the whole allowlist is unit-testable. The bottom half is the only place in the
 * project that is allowed to call `fetch` towards an inference host, and it refuses to do so for a
 * URL the pure half has not approved.
 */

import { FinanceError, FinanceErrorCode } from "../core/domain/errors.ts";

/* --------------------------------------------------------------------------------------------- */
/* Rejection reasons                                                                               */
/* --------------------------------------------------------------------------------------------- */

/**
 * Stable machine-readable reasons. They are attached to the error's `details.reason` so the setup
 * screen can explain the exact control that refused, and so tests can assert the control rather
 * than a message string.
 */
export const EndpointRejection = {
  MALFORMED_URL: "malformed_url",
  SCHEME_NOT_ALLOWED: "scheme_not_allowed",
  PLAINTEXT_NOT_APPROVED: "plaintext_not_approved",
  CREDENTIALS_IN_URL: "credentials_in_url",
  FRAGMENT_NOT_ALLOWED: "fragment_not_allowed",
  QUERY_NOT_ALLOWED: "query_not_allowed",
  HOST_NOT_ALLOWED: "host_not_allowed",
  PORT_NOT_ALLOWED: "port_not_allowed",
  PATH_NOT_ALLOWED: "path_not_allowed",
  PATH_TRAVERSAL: "path_traversal",
  LINK_LOCAL_TARGET: "link_local_target",
  METADATA_TARGET: "metadata_target",
  RESERVED_ADDRESS: "reserved_address",
  PRIVATE_NETWORK_NOT_APPROVED: "private_network_not_approved",
  LOOPBACK_NOT_APPROVED: "loopback_not_approved",
  REDIRECT_REFUSED: "redirect_refused",
  RESPONSE_TOO_LARGE: "response_too_large",
  TIMEOUT: "timeout",
  TRANSPORT_FAILURE: "transport_failure",
} as const;

export type EndpointRejection = (typeof EndpointRejection)[keyof typeof EndpointRejection];

const ALL_REJECTIONS: readonly string[] = Object.values(EndpointRejection);

export function endpointDenied(
  reason: EndpointRejection,
  message: string,
  details: Readonly<Record<string, string>> = {},
): FinanceError {
  return new FinanceError(FinanceErrorCode.PERMISSION_DENIED, message, { reason, ...details });
}

/** Reads the machine-readable reason back off an error, or `null` if it is not an endpoint denial. */
export function rejectionReasonOf(error: unknown): EndpointRejection | null {
  if (!(error instanceof FinanceError)) return null;
  const reason = error.details["reason"];
  if (typeof reason === "string" && ALL_REJECTIONS.includes(reason)) {
    return reason as EndpointRejection;
  }
  return null;
}

/* --------------------------------------------------------------------------------------------- */
/* Address classification                                                                          */
/* --------------------------------------------------------------------------------------------- */

export const AddressClass = {
  LOOPBACK: "loopback",
  PRIVATE: "private",
  LINK_LOCAL: "link_local",
  UNIQUE_LOCAL: "unique_local",
  SHARED_CGNAT: "shared_cgnat",
  UNSPECIFIED: "unspecified",
  RESERVED: "reserved",
  PUBLIC: "public",
} as const;

export type AddressClass = (typeof AddressClass)[keyof typeof AddressClass];

export type HostTarget = {
  /** `ipv4`/`ipv6` when the host is a literal address, `name` when DNS resolution is required. */
  readonly kind: "ipv4" | "ipv6" | "name";
  /** The WHATWG-normalised hostname, e.g. `192.168.1.118`, `[::1]`, `extractor.home.example`. */
  readonly hostname: string;
  /** Dotted-quad / canonical address for literals, the lowercased name otherwise. */
  readonly canonical: string;
  /** `null` for names: a name's class is only known after resolution. */
  readonly addressClass: AddressClass | null;
  /** True for cloud instance-metadata endpoints, which are refused unconditionally. */
  readonly isMetadata: boolean;
};

/**
 * Cloud instance-metadata endpoints. These are refused even if the owner "configures" them,
 * because the only reason a finance app would reach them is credential theft (buildspec.md §18:
 * "reject metadata/link-local targets").
 */
const METADATA_ADDRESSES: readonly string[] = [
  "169.254.169.254", // AWS / Azure / GCP / DigitalOcean / Oracle IMDS
  "169.254.170.2", // AWS ECS task metadata
  "169.254.169.253", // AWS VPC DNS-adjacent metadata helper
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192", // Oracle Cloud legacy
  "fd00:ec2:0:0:0:0:0:254", // AWS IPv6 IMDS
];

const METADATA_HOSTNAMES: readonly string[] = [
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
];

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(text: string): readonly number[] | null {
  const match = IPV4_PATTERN.exec(text);
  if (!match) return null;
  const bytes = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes as readonly number[];
}

/** Parses a bracket-free IPv6 literal into 16 bytes, handling `::` and a trailing IPv4 tail. */
function parseIpv6(text: string): readonly number[] | null {
  if (text.includes("%")) return null; // scope ids are never acceptable here
  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const headText = doubleColon === -1 ? text : text.slice(0, doubleColon);
  const tailText = doubleColon === -1 ? "" : text.slice(doubleColon + 2);

  const toGroups = (part: string): number[][] | null => {
    if (part === "") return [];
    const out: number[][] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? "";
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push([v4[0] ?? 0, v4[1] ?? 0]);
        out.push([v4[2] ?? 0, v4[3] ?? 0]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      const value = Number.parseInt(piece, 16);
      out.push([(value >> 8) & 0xff, value & 0xff]);
    }
    return out;
  };

  const head = toGroups(headText);
  const tail = toGroups(tailText);
  if (head === null || tail === null) return null;

  const fill = 8 - head.length - tail.length;
  if (doubleColon === -1 ? fill !== 0 : fill < 0) return null;

  const groups = [...head, ...Array.from({ length: fill }, () => [0, 0]), ...tail];
  if (groups.length !== 8) return null;
  return groups.flat();
}

function classifyIpv4(bytes: readonly number[]): AddressClass {
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0) return AddressClass.UNSPECIFIED;
  if (a === 127) return AddressClass.LOOPBACK;
  if (a === 169 && b === 254) return AddressClass.LINK_LOCAL;
  if (a === 10) return AddressClass.PRIVATE;
  if (a === 172 && b >= 16 && b <= 31) return AddressClass.PRIVATE;
  if (a === 192 && b === 168) return AddressClass.PRIVATE;
  if (a === 100 && b >= 64 && b <= 127) return AddressClass.SHARED_CGNAT;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return AddressClass.RESERVED;
  if (a === 198 && (b === 18 || b === 19)) return AddressClass.RESERVED;
  if (a === 198 && b === 51 && c === 100) return AddressClass.RESERVED;
  if (a === 203 && b === 0 && c === 113) return AddressClass.RESERVED;
  if (a >= 224) return AddressClass.RESERVED; // multicast and 240/4
  return AddressClass.PUBLIC;
}

function formatIpv4(bytes: readonly number[]): string {
  return bytes.join(".");
}

function formatIpv6(bytes: readonly number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(":");
}

function classifyIpv6(bytes: readonly number[]): { addressClass: AddressClass; canonical: string } {
  const isAllZeroPrefix = (upTo: number): boolean =>
    bytes.slice(0, upTo).every((byte) => byte === 0);
  const canonical = formatIpv6(bytes);

  // `::` and `::1` must be settled before the embedded-IPv4 forms, or `::1` reads as `0.0.0.1`.
  if (bytes.every((byte) => byte === 0)) {
    return { addressClass: AddressClass.UNSPECIFIED, canonical };
  }
  if (isAllZeroPrefix(15) && bytes[15] === 1) {
    return { addressClass: AddressClass.LOOPBACK, canonical };
  }

  /*
   * `::ffff:a.b.c.d` (v4-mapped) and the deprecated `::a.b.c.d` (v4-compatible) both reach an
   * IPv4 destination, so they are classified by the embedded address instead of looking "public".
   * `::ffff:a9fe:a9fe` is how the metadata service hides inside an IPv6 literal.
   */
  const mapped =
    isAllZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff
      ? bytes.slice(12)
      : isAllZeroPrefix(12) && (bytes[12] ?? 0) !== 0
        ? bytes.slice(12)
        : null;
  if (mapped) {
    return { addressClass: classifyIpv4(mapped), canonical: formatIpv4(mapped) };
  }

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xfe && (second & 0xc0) === 0x80) {
    return { addressClass: AddressClass.LINK_LOCAL, canonical };
  }
  if ((first & 0xfe) === 0xfc) {
    return { addressClass: AddressClass.UNIQUE_LOCAL, canonical };
  }
  if (first === 0xff) {
    return { addressClass: AddressClass.RESERVED, canonical }; // multicast
  }
  if (first === 0x20 && second === 0x02) {
    return { addressClass: AddressClass.RESERVED, canonical }; // 6to4 relay
  }
  return { addressClass: AddressClass.PUBLIC, canonical };
}

/**
 * Classifies a hostname taken from a parsed URL.
 *
 * The WHATWG URL parser has already normalised the exotic IPv4 spellings (`0x7f000001`,
 * `2130706433`, `127.1`) to dotted quads and lowercased IPv6 literals, so this only has to deal
 * with canonical forms plus the IPv4-in-IPv6 embeddings the parser preserves.
 */
export function classifyHostname(hostname: string): HostTarget {
  const trimmed = hostname.trim().replace(/\.$/, "").toLowerCase();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const bytes = parseIpv6(trimmed.slice(1, -1));
    if (!bytes) {
      return {
        kind: "name",
        hostname: trimmed,
        canonical: trimmed,
        addressClass: null,
        isMetadata: false,
      };
    }
    const { addressClass, canonical } = classifyIpv6(bytes);
    return {
      kind: "ipv6",
      hostname: trimmed,
      canonical,
      addressClass,
      isMetadata: METADATA_ADDRESSES.includes(canonical) || METADATA_ADDRESSES.includes(formatIpv6(bytes)),
    };
  }

  const v4 = parseIpv4(trimmed);
  if (v4) {
    const canonical = formatIpv4(v4);
    return {
      kind: "ipv4",
      hostname: trimmed,
      canonical,
      addressClass: classifyIpv4(v4),
      isMetadata: METADATA_ADDRESSES.includes(canonical),
    };
  }

  return {
    kind: "name",
    hostname: trimmed,
    canonical: trimmed,
    addressClass: null,
    isMetadata: METADATA_HOSTNAMES.includes(trimmed),
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Policy                                                                                          */
/* --------------------------------------------------------------------------------------------- */

export type EndpointPolicyInput = {
  /** Owner-configured base URL, e.g. `http://192.168.1.118:8081/v1`. */
  readonly baseUrl: string;
  /** Exact absolute paths this client may ever request. Nothing else is reachable. */
  readonly allowedPaths: readonly string[];
  /**
   * buildspec.md §18: plain HTTP "may be allowed only for a specifically approved local/private
   * host and only in a clearly labeled development configuration".
   */
  readonly allowPlaintextHttp?: boolean | undefined;
  /**
   * buildspec.md §18: "Private LAN addresses are legitimate only when the owner explicitly
   * configured them."
   */
  readonly allowPrivateNetwork?: boolean | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly readTimeoutMs?: number | undefined;
  /** Shown in setup and in diagnostics, e.g. `development-lan`. */
  readonly configLabel?: string | undefined;
};

export type EndpointPolicy = {
  readonly origin: string;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
  /** Path prefix of the configured base URL, without a trailing slash (may be ""). */
  readonly basePath: string;
  readonly allowedPaths: readonly string[];
  readonly allowPlaintextHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly maxResponseBytes: number;
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly configLabel: string;
  readonly target: HostTarget;
};

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_READ_TIMEOUT_MS = 120_000;

const MAX_QUERY_LENGTH = 256;

function defaultPortFor(scheme: string): number {
  return scheme === "https:" ? 443 : 80;
}

/** Joins a base path and a sub-path into one normalised absolute path. */
export function joinPath(basePath: string, subPath: string): string {
  const base = basePath.replace(/\/+$/, "");
  const sub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  const joined = `${base}${sub}`.replace(/\/{2,}/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * Validates the owner's configuration itself and freezes it into a policy.
 *
 * Construction is where "the owner explicitly configured this host" is recorded. Nothing later can
 * widen it: `assertEndpointAllowed` only ever compares against these frozen values, so an agent
 * that smuggles a URL through a tool argument still cannot reach a new destination.
 */
export function createEndpointPolicy(input: EndpointPolicyInput): EndpointPolicy {
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    throw endpointDenied(
      EndpointRejection.MALFORMED_URL,
      `Configured endpoint '${input.baseUrl}' is not a valid absolute URL`,
    );
  }

  const allowPlaintextHttp = input.allowPlaintextHttp ?? false;
  const allowPrivateNetwork = input.allowPrivateNetwork ?? false;
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const target = classifyHostname(parsed.hostname);
  const port = parsed.port === "" ? defaultPortFor(parsed.protocol) : Number(parsed.port);

  checkOrigin(parsed, target, { allowPlaintextHttp, allowPrivateNetwork });

  if (input.allowedPaths.length === 0) {
    throw endpointDenied(
      EndpointRejection.PATH_NOT_ALLOWED,
      "An endpoint policy with no allowed paths can never be used",
      { base_url: redactUrl(input.baseUrl) },
    );
  }

  const basePath = parsed.pathname.replace(/\/+$/, "");
  const allowedPaths = Object.freeze([
    ...new Set(input.allowedPaths.map((path) => joinPath("", path))),
  ]);

  return Object.freeze({
    origin: parsed.origin,
    scheme,
    host: target.hostname,
    port,
    basePath,
    allowedPaths,
    allowPlaintextHttp,
    allowPrivateNetwork,
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    connectTimeoutMs: input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    readTimeoutMs: input.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    configLabel: input.configLabel ?? "unlabeled",
    target,
  });
}

type OriginFlags = { allowPlaintextHttp: boolean; allowPrivateNetwork: boolean };

/** Scheme, credential and destination-class checks shared by configuration and per-request checks. */
function checkOrigin(url: URL, target: HostTarget, flags: OriginFlags): void {
  const where = { host: target.hostname };

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw endpointDenied(
      EndpointRejection.SCHEME_NOT_ALLOWED,
      `Only http and https are supported, got '${url.protocol.replace(":", "")}'`,
      where,
    );
  }
  if (url.username !== "" || url.password !== "") {
    // buildspec.md §18: "Never place secrets in Git, regular preferences, URLs, audit payloads..."
    throw endpointDenied(
      EndpointRejection.CREDENTIALS_IN_URL,
      "Credentials embedded in the endpoint URL are not accepted; use the secret store",
      where,
    );
  }

  // Metadata and link-local targets are refused unconditionally: no owner configuration makes
  // them legitimate for a finance app (buildspec.md §18).
  if (target.isMetadata) {
    throw endpointDenied(
      EndpointRejection.METADATA_TARGET,
      `'${target.hostname}' is a cloud instance-metadata endpoint and is never reachable from this client`,
      where,
    );
  }
  if (target.addressClass === AddressClass.LINK_LOCAL) {
    throw endpointDenied(
      EndpointRejection.LINK_LOCAL_TARGET,
      `'${target.hostname}' is link-local (169.254.0.0/16 or fe80::/10) and is never reachable from this client`,
      where,
    );
  }
  if (
    target.addressClass === AddressClass.RESERVED ||
    target.addressClass === AddressClass.UNSPECIFIED
  ) {
    throw endpointDenied(
      EndpointRejection.RESERVED_ADDRESS,
      `'${target.hostname}' is a reserved address and is not a valid inference host`,
      where,
    );
  }

  const isLoopback = target.addressClass === AddressClass.LOOPBACK;
  const isPrivate =
    target.addressClass === AddressClass.PRIVATE ||
    target.addressClass === AddressClass.UNIQUE_LOCAL ||
    target.addressClass === AddressClass.SHARED_CGNAT;

  if (isLoopback && !flags.allowPrivateNetwork) {
    throw endpointDenied(
      EndpointRejection.LOOPBACK_NOT_APPROVED,
      `'${target.hostname}' is loopback; the owner must explicitly approve a local host first`,
      where,
    );
  }
  if (isPrivate && !flags.allowPrivateNetwork) {
    throw endpointDenied(
      EndpointRejection.PRIVATE_NETWORK_NOT_APPROVED,
      `'${target.hostname}' is a private LAN address; buildspec §18 requires the owner to ` +
        "explicitly configure that exact host before it can be used",
      where,
    );
  }

  if (url.protocol === "http:") {
    if (!flags.allowPlaintextHttp) {
      throw endpointDenied(
        EndpointRejection.PLAINTEXT_NOT_APPROVED,
        "Plain HTTP requires an explicitly approved local/private host in a labeled development configuration",
        where,
      );
    }
    if (!isLoopback && !isPrivate) {
      throw endpointDenied(
        EndpointRejection.PLAINTEXT_NOT_APPROVED,
        `Plain HTTP is only ever allowed towards loopback or an approved private host, not '${target.hostname}'`,
        where,
      );
    }
  }
}

/** Removes any query string and userinfo before a URL reaches a log line or an error message. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * The single allowlist gate. Pure: no DNS, no sockets, no clock.
 *
 * Returns the parsed URL so callers cannot accidentally fetch a different string than the one that
 * was approved.
 */
export function assertEndpointAllowed(url: string | URL, policy: EndpointPolicy): URL {
  const rawInput = typeof url === "string" ? url : url.toString();
  let parsed: URL;
  try {
    parsed = new URL(rawInput);
  } catch {
    throw endpointDenied(
      EndpointRejection.MALFORMED_URL,
      `'${String(url)}' is not a valid absolute URL`,
    );
  }

  const target = classifyHostname(parsed.hostname);
  checkOrigin(parsed, target, {
    allowPlaintextHttp: policy.allowPlaintextHttp,
    allowPrivateNetwork: policy.allowPrivateNetwork,
  });

  const scheme = parsed.protocol === "https:" ? "https" : "http";
  if (scheme !== policy.scheme) {
    throw endpointDenied(
      EndpointRejection.SCHEME_NOT_ALLOWED,
      `Endpoint scheme '${scheme}' does not match the configured '${policy.scheme}'`,
      { configured: policy.scheme, requested: scheme },
    );
  }
  if (target.hostname !== policy.host) {
    throw endpointDenied(
      EndpointRejection.HOST_NOT_ALLOWED,
      `Host '${target.hostname}' is not the configured inference host '${policy.host}'`,
      { configured: policy.host, requested: target.hostname },
    );
  }
  const port = parsed.port === "" ? defaultPortFor(parsed.protocol) : Number(parsed.port);
  if (port !== policy.port) {
    throw endpointDenied(
      EndpointRejection.PORT_NOT_ALLOWED,
      `Port ${port} is not the configured inference port ${policy.port}`,
      { configured: String(policy.port), requested: String(port) },
    );
  }

  if (parsed.hash !== "") {
    throw endpointDenied(EndpointRejection.FRAGMENT_NOT_ALLOWED, "Endpoint URLs must not carry a fragment");
  }
  if (parsed.search.length > MAX_QUERY_LENGTH) {
    throw endpointDenied(
      EndpointRejection.QUERY_NOT_ALLOWED,
      `Endpoint query string exceeds ${MAX_QUERY_LENGTH} characters`,
    );
  }

  /*
   * Traversal is checked on the string the caller handed in, not only on the parsed result.
   * `new URL` silently collapses `/v1/../admin` into `/admin` and decodes `%2e%2e` into `..`, so
   * by the time the path is parsed the trick is invisible; some servers then re-decode it on their
   * side (buildspec.md §22 "path/URL tricks"). The exact-path allowlist below is the real defence,
   * but a crafted path deserves its own named reason rather than a generic "not allowed".
   */
  const rawPath = parsed.pathname;
  const traversal = /(^|\/)\.\.(\/|$)/;
  if (
    /%2e/i.test(rawInput) ||
    traversal.test(rawInput.replace(/^[a-z]+:\/\//i, "")) ||
    traversal.test(decodeSafe(rawPath))
  ) {
    throw endpointDenied(EndpointRejection.PATH_TRAVERSAL, `Path '${rawPath}' contains traversal segments`, {
      path: rawPath,
    });
  }
  if (!policy.allowedPaths.includes(rawPath)) {
    throw endpointDenied(
      EndpointRejection.PATH_NOT_ALLOWED,
      `Path '${rawPath}' is not one of this client's allowed API paths`,
      { path: rawPath, allowed: policy.allowedPaths.join(", ") },
    );
  }

  return parsed;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Validates an address that DNS produced for a configured *name* host.
 *
 * buildspec.md §18: "Resolve and validate destinations on connection, prevent redirects/DNS changes
 * to unapproved destinations". A hostname that resolves into the LAN or to the metadata service is
 * rejected even though the name itself passed the allowlist.
 */
export function assertResolvedAddressAllowed(address: string, policy: EndpointPolicy): void {
  const target = classifyHostname(address.includes(":") && !address.includes(".") ? `[${address}]` : address);
  if (target.addressClass === null) {
    throw endpointDenied(
      EndpointRejection.HOST_NOT_ALLOWED,
      `'${address}' is not a literal IP address and cannot be validated as a resolution result`,
    );
  }
  checkOrigin(new URL(`${policy.scheme}://${policy.host}:${policy.port}`), target, {
    allowPlaintextHttp: policy.allowPlaintextHttp,
    allowPrivateNetwork: policy.allowPrivateNetwork,
  });
}

/* --------------------------------------------------------------------------------------------- */
/* Transport                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpRequestOptions = {
  /** Absolute path; must be in `policy.allowedPaths`. */
  readonly path: string;
  readonly method?: "GET" | "POST" | undefined;
  /** Serialised as JSON when present. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Overall deadline. Defaults to `connectTimeoutMs + readTimeoutMs`. */
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: FetchLike | undefined;
};

export type HttpJsonResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly json: unknown;
  readonly parseError: string | null;
  readonly latencyMs: number;
  readonly bytes: number;
};

/**
 * The only network call this project makes towards an inference host.
 *
 * Redirects are refused rather than followed (`redirect: "error"` plus an explicit 3xx check), the
 * body is read through a byte counter that aborts past the cap, and the whole call sits under a
 * deadline. Nothing here consults the response for a new destination.
 */
export async function requestJson(
  policy: EndpointPolicy,
  options: HttpRequestOptions,
): Promise<HttpJsonResponse> {
  const url = assertEndpointAllowed(`${policy.origin}${options.path}`, policy);
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) {
    throw endpointDenied(EndpointRejection.TRANSPORT_FAILURE, "No fetch implementation is available");
  }

  const deadlineMs = options.timeoutMs ?? policy.connectTimeoutMs + policy.readTimeoutMs;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const deadlineTimer = setTimeout(() => controller.abort(new Error("deadline")), deadlineMs);

  const started = Date.now();
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    };

    const response = await doFetch(url.toString(), {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // buildspec.md §18: redirects must not silently move the destination.
      redirect: "error",
      signal: controller.signal,
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw endpointDenied(
        EndpointRejection.REDIRECT_REFUSED,
        `Endpoint answered with a redirect (status ${response.status}); redirects are never followed`,
        { status: String(response.status) },
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > policy.maxResponseBytes) {
      throw endpointDenied(
        EndpointRejection.RESPONSE_TOO_LARGE,
        `Endpoint declared ${declaredLength} bytes, over the ${policy.maxResponseBytes}-byte cap`,
        { declared: String(declaredLength), cap: String(policy.maxResponseBytes) },
      );
    }

    const { text, bytes } = await readCapped(response, policy.maxResponseBytes, policy.readTimeoutMs);
    const latencyMs = Date.now() - started;

    let json: unknown = null;
    let parseError: string | null = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    const headerRecord: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerRecord[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: Object.freeze(headerRecord),
      text,
      json,
      parseError,
      latencyMs,
      bytes,
    };
  } catch (error) {
    if (error instanceof FinanceError) throw error;
    if (controller.signal.aborted) {
      throw endpointDenied(
        EndpointRejection.TIMEOUT,
        `Endpoint did not answer ${redactUrl(url.toString())} within ${deadlineMs} ms`,
        { timeout_ms: String(deadlineMs) },
      );
    }
    throw endpointDenied(
      EndpointRejection.TRANSPORT_FAILURE,
      `Could not reach ${redactUrl(url.toString())}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Reads a response body under a hard byte cap and an idle-gap timeout.
 *
 * `response.text()` would buffer whatever the host decides to send, so the stream is consumed
 * chunk by chunk and cancelled the moment the cap is passed. A host that opens a response and then
 * stalls is caught by the per-chunk timer rather than only by the overall deadline.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  idleTimeoutMs: number,
): Promise<{ text: string; bytes: number }> {
  const body = response.body;
  if (!body) return { text: "", bytes: 0 };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              endpointDenied(
                EndpointRejection.TIMEOUT,
                `Endpoint stopped sending data for ${idleTimeoutMs} ms`,
                { timeout_ms: String(idleTimeoutMs) },
              ),
            ),
          idleTimeoutMs,
        );
      });

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }

      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw endpointDenied(
          EndpointRejection.RESPONSE_TOO_LARGE,
          `Endpoint response exceeded the ${maxBytes}-byte cap`,
          { cap: String(maxBytes) },
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { text: parts.join(""), bytes: total };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
