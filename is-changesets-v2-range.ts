import subset from "semver/ranges/subset.js";
import validRange from "semver/ranges/valid.js";

const changesetsV2Range = ">=2.0.0 <3.0.0";

export function isChangesetsV2Range(declaredVersion: string | undefined) {
  if (declaredVersion === undefined) {
    return false;
  }

  const range = validRange(declaredVersion);
  return range !== null && subset(range, changesetsV2Range);
}
