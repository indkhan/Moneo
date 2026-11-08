import { expect, it } from "vitest";
import { syncProblems } from "./sync-problems";

it("speaks up about a failed sync or an ended login, and stays quiet otherwise", () => {
  expect(syncProblems([{ name: "Scalable", status: "active", last_error: null }])).toEqual([]);
  expect(syncProblems([{ name: "Scalable", status: "active", last_error: "The Scalable sync failed." }])).toEqual(["Scalable could not sync, so its numbers may be old. Moneo tries again by itself."]);
  expect(syncProblems([{ name: "Revolut", status: "expired", last_error: "Bank consent expired" }])).toEqual(["Revolut needs reconnecting, so its numbers may be old."]);
});

it("forgets an old ended login once the service is connected again", () => {
  expect(syncProblems([{ name: "Revolut", status: "expired", last_error: "Bank consent expired" }, { name: "Revolut", status: "active", last_error: null }])).toEqual([]);
});
