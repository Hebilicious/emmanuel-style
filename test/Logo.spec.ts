import { mount } from "@vue/test-utils"
import Logo from "../components/Logo.vue"
import { describe, test, expect } from "vitest"

describe("Logo", () => {
  test("is a Vue instance", () => {
    const wrapper = mount(Logo)
    expect(wrapper.vm).toBeTruthy()
  })
})
