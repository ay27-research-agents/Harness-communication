/** Offline inventory data. Asset and service names are labels, never network targets. */
export type InventoryRow = { asset: string; services: string[] };

export type Fixture = {
  name: string;
  expected: InventoryRow[];
  observed: InventoryRow[];
};

export const sampleFixture: Fixture = {
  name: "offline-inventory-comparison",
  expected: [
    { asset: "catalog", services: ["api", "metrics"] },
    { asset: "reporting", services: ["api"] },
    { asset: "scheduler", services: ["worker"] },
  ],
  observed: [
    { asset: "catalog", services: ["api"] },
    { asset: "reporting", services: ["api", "debug"] },
    { asset: "scheduler", services: ["worker"] },
  ],
};
