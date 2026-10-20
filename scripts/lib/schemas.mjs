import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule.default ?? addFormatsModule;
const here = new URL("../../schema/", import.meta.url);

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

function load(name) {
  return ajv.compile(JSON.parse(readFileSync(new URL(name, here), "utf8")));
}

const validators = {
  entry: load("entry.schema.json"),
  index: load("index.schema.json"),
  stats: load("stats.schema.json"),
};

/** @returns {string[]} human-readable problems, empty when valid */
export function schemaErrors(kind, value) {
  const validate = validators[kind];
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `${e.instancePath || "(root)"} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ""}`,
  );
}
