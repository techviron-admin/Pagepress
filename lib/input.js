export class InputError extends Error {}

export function parseDriveLink(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new InputError("Enter a complete Google Drive PDF link.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drive.google.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new InputError(
      "Only https://drive.google.com file links are supported.",
    );
  }
  if (url.pathname.includes("/folders/")) {
    throw new InputError(
      "Use an individual PDF file link, not a Drive folder.",
    );
  }
  const match = url.pathname.match(
    /^\/file\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/(?:view|preview|edit))?\/?$/,
  );
  const id =
    match?.[1] ||
    (["/open", "/uc"].includes(url.pathname)
      ? url.searchParams.get("id")
      : null);
  if (!id || !/^[\w-]{10,200}$/.test(id)) {
    throw new InputError("This link does not identify a Google Drive file.");
  }
  const canonical = new URL(`https://drive.google.com/file/d/${id}/view`);
  const resourceKey = url.searchParams.get("resourcekey");
  if (resourceKey) {
    if (!/^[\w-]{1,200}$/.test(resourceKey))
      throw new InputError("Invalid Drive resource key.");
    canonical.searchParams.set("resourcekey", resourceKey);
  }
  return { id, url: canonical.href };
}

export function selectPages(total) {
  if (!Number.isInteger(total) || total < 1)
    throw new InputError("The viewer has no PDF pages.");
  if (total > 500)
    throw new InputError(
      "This document exceeds the 500-page capture limit. No partial PDF will be saved.",
    );
  return Array.from({ length: total }, (_, index) => index + 1);
}

export function outputName(title) {
  let name = String(title || "Drive document")
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 130);
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name))
    name = "Drive document";
  return `${name} (page capture).pdf`;
}
