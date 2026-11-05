import { expect, it } from "vitest";
import { closestNames, normaliseName } from "../src/names.ts";
import type { Project } from "../src/types.ts";

const p = (name: string): Project => ({ id: name, name, colour: "", kind: "project", created_at: "" });

it("normaliseName lowercases and strips punctuation and spaces", () => {
  expect(normaliseName("RSE-Diary ")).toBe("rsediary");
});

it("closestNames prefers substring matches", () => {
  expect(closestNames("glo", [p("Hydra"), p("Glow")])[0]).toBe("Glow");
});

it("closestNames falls back to edit distance and caps the list", () => {
  const ps = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map(p);
  const out = closestNames("Deltta", ps);
  expect(out[0]).toBe("Delta");
  expect(out).toHaveLength(5);
});
