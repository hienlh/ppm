/**
 * The Bastion host field, `[user@]host[:port]`, read the same in the form and on the server.
 */
import { describe, expect, it } from "bun:test";
import { parseSshAddress } from "../../../src/shared/db-connection-config.ts";

describe("parseSshAddress", () => {
  it("reads a host alone, with a port, and with a login", () => {
    expect(parseSshAddress("jump.example.com")).toEqual({ user: "", host: "jump.example.com", port: 22 });
    expect(parseSshAddress(" jump.example.com:2222 ")).toEqual({ user: "", host: "jump.example.com", port: 2222 });
    expect(parseSshAddress("deploy@jump.example.com:2222")).toEqual({ user: "deploy", host: "jump.example.com", port: 2222 });
  });

  it("takes the last @ as the separator, as ssh does for a login holding one", () => {
    expect(parseSshAddress("ci@corp@jump:22")).toEqual({ user: "ci@corp", host: "jump", port: 22 });
  });

  it("reads an IPv6 address only in brackets", () => {
    expect(parseSshAddress("[::1]:2200")).toEqual({ user: "", host: "::1", port: 2200 });
    expect(parseSshAddress("root@[fe80::1]")).toEqual({ user: "root", host: "fe80::1", port: 22 });
    expect(parseSshAddress("::1")).toEqual({ error: "Write an IPv6 address in brackets, like [::1]:22." });
    expect(parseSshAddress("[::1")).toEqual({ error: "Write an IPv6 address in brackets, like [::1]:22." });
    expect(parseSshAddress("[::1]x")).toEqual({ error: "Write an IPv6 address in brackets, like [::1]:22." });
  });

  it("refuses what cannot be a host or a port", () => {
    const noHost = { error: "Enter the bastion's host name, like jump.example.com or deploy@jump.example.com:22." };
    expect(parseSshAddress("")).toEqual(noHost);
    expect(parseSshAddress("deploy@")).toEqual(noHost);
    expect(parseSshAddress("ssh://jump")).toEqual({ error: "Write the bastion as host or user@host:port, without ssh://." });
    expect(parseSshAddress("jump host")).toEqual(noHost);
    expect(parseSshAddress("jump/22")).toEqual(noHost);
    const badPort = { error: "The bastion's port must be a number from 1 to 65535." };
    expect(parseSshAddress("jump:0")).toEqual(badPort);
    expect(parseSshAddress("jump:65536")).toEqual(badPort);
    expect(parseSshAddress("jump:22a")).toEqual(badPort);
    expect(parseSshAddress("jump:")).toEqual(badPort);
    expect(parseSshAddress("[::1]:")).toEqual(badPort);
  });
});
