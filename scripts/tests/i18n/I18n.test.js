import { describe, it, expect, beforeEach } from "vitest";
import { localize, format } from "../../utils/I18n.js";
import { resetTranslations } from "../setup/foundryI18nMock.js";

describe("I18n", () => {
    beforeEach(() => {
        resetTranslations({
            "IONRIFT.QUARTERMASTER.TEST.Hello": "Hello",
            "IONRIFT.QUARTERMASTER.TEST.HelloName": "Hello, {name}"
        });
    });

    it("localizes known keys", () => {
        expect(localize("IONRIFT.QUARTERMASTER.TEST.Hello")).toBe("Hello");
    });

    it("returns key when missing", () => {
        expect(localize("IONRIFT.QUARTERMASTER.TEST.Missing")).toBe("IONRIFT.QUARTERMASTER.TEST.Missing");
    });

    it("formats interpolations", () => {
        expect(format("IONRIFT.QUARTERMASTER.TEST.HelloName", { name: "GM" })).toBe("Hello, GM");
    });
});
