import { describe, it, expect } from "vitest"
import { isInfraWorkload, appServices } from "./service-filter"

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
