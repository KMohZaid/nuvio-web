import assert from "node:assert/strict";
import test from "node:test";

import { mdbListRatings } from "../src/lib/metadataEnrichment.ts";

test("MDBList single-title ratings retain native provider display scales", () => {
  const result = mdbListRatings(
    {
      ratings: [
        { source: "imdb", value: 8.3, score: 83 },
        { source: "tmdb", value: 8.1, score: 81 },
        { source: "trakt", value: 8.2, score: 82 },
        { source: "tomatoes", value: 8.8, score: 88 },
        { source: "audience", value: 7.2, score: 72 },
        { source: "letterboxd", value: 4.1, score: 82 },
      ],
    },
    ["imdb", "tmdb", "trakt", "tomatoes", "audience", "letterboxd"],
  );

  assert.deepEqual(result, [
    { source: "imdb", value: 8.3 },
    { source: "tmdb", value: 81 },
    { source: "trakt", value: 82 },
    { source: "tomatoes", value: 88 },
    { source: "audience", value: 72 },
    { source: "letterboxd", value: 4.1 },
  ]);
});

test("MDBList rating aliases and keyed responses respect enabled providers", () => {
  const result = mdbListRatings(
    {
      ratings: {
        "Rotten Tomatoes": { rating: 91 },
        Popcorn: { rating: 78 },
        Metacritic: 64,
      },
    },
    ["tomatoes", "audience"],
  );

  assert.deepEqual(result, [
    { source: "tomatoes", value: 91 },
    { source: "audience", value: 78 },
  ]);
});
