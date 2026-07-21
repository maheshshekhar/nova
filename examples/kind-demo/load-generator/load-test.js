import http from "k6/http"

export const options = {
  scenarios: {
    checkout_storm: {
      executor: "constant-vus",
      vus: 120,
      duration: "10m",
    },
  },
}

const TARGET = __ENV.TARGET_URL || "http://payment-service/api/checkout"

export default function () {
  const payload = JSON.stringify({ amount: 99.99, currency: "USD" })
  const params = { headers: { "Content-Type": "application/json" } }
  http.post(TARGET, payload, params)
  // No sleep — maximum concurrent pressure
}
