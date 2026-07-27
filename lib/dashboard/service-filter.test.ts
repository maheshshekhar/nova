import { describe, it, expect } from "vitest"
import { isInfraWorkload, appServices, rankBySeverity, capServices } from "./service-filter"

describe("isInfraWorkload", () => {
  it("treats nothing as infra when no patterns are configured", () => {
    expect(isInfraWorkload({ name: "anything" }, [])).toBe(false)
  })

  it("matches on a name substring, case-insensitively", () => {
    expect(isInfraWorkload({ name: "ingress-nginx-controller" }, ["ingress-nginx"])).toBe(true)
    expect(isInfraWorkload({ name: "INGRESS" }, ["ingress"])).toBe(true)
  })

  it("matches on a namespace substring", () => {
    expect(isInfraWorkload({ name: "coredns", namespace: "kube-system" }, ["kube-system"])).toBe(
      true
    )
  })

  it("does not match unrelated workloads", () => {
    expect(isInfraWorkload({ name: "checkout", namespace: "shop" }, ["kube-system"])).toBe(false)
  })

  it("ignores empty/whitespace patterns", () => {
    expect(isInfraWorkload({ name: "checkout" }, ["", "   "])).toBe(false)
  })
})

describe("appServices", () => {
  it("removes infra workloads, keeps app services", () => {
    const svcs = [
      { name: "checkout", namespace: "shop" },
      { name: "ingress-nginx", namespace: "ingress-nginx" },
      { name: "orders", namespace: "shop" },
      { name: "coredns", namespace: "kube-system" },
    ]
    const result = appServices(svcs, ["ingress-nginx", "kube-system"])
    expect(result.map((s) => s.name)).toEqual(["checkout", "orders"])
  })

  it("returns everything when no infra configured", () => {
    const svcs = [{ name: "a" }, { name: "b" }]
    expect(appServices(svcs, [])).toHaveLength(2)
  })
})

describe("rankBySeverity", () => {
  const svcs = [
    { name: "a", status: "healthy" },
    { name: "b", status: "critical" },
    { name: "c", status: "healthy" },
    { name: "d", status: "degraded" },
  ]

  it("orders worst-severity first, keeping input order within a tier", () => {
    expect(rankBySeverity(svcs).map((s) => s.name)).toEqual(["b", "d", "a", "c"])
  })

  it("does not mutate the input array", () => {
    const copy = [...svcs]
    rankBySeverity(svcs)
    expect(svcs).toEqual(copy)
  })
})

describe("capServices", () => {
  const svcs = [
    { name: "a", status: "healthy" },
    { name: "b", status: "critical" },
    { name: "c", status: "degraded" },
  ]

  it("returns all services (ranked) when topN is undefined", () => {
    expect(capServices(svcs).map((s) => s.name)).toEqual(["b", "c", "a"])
  })

  it("caps to the worst-severity topN", () => {
    expect(capServices(svcs, 2).map((s) => s.name)).toEqual(["b", "c"])
  })

  it("treats 0 as no cap", () => {
    expect(capServices(svcs, 0)).toHaveLength(3)
  })
})
