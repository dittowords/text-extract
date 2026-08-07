/** @type {import('jest').Config} */
module.exports = {
  transformIgnorePatterns: [],
  moduleNameMapper: {
    // globby v16 is ESM-only and unicorn-magic exports "./node" under the
    // `import` condition only, so jest's CJS resolver can't find it.
    "^unicorn-magic/node$": "<rootDir>/node_modules/unicorn-magic/node.js",
  },
  maxWorkers: 1,
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/dist/"],
  collectCoverageFrom: ["src/**/*.ts"],
  restoreMocks: true,
};
