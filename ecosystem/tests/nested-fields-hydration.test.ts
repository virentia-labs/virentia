import { expect, it, vi } from "vitest";
import { computed, scope, scoped, serialize } from "@virentia/core";
import { children, staticModel, type InstanceOf } from "@virentia/core/models";
import { createForm } from "@virentia/forms";
import { arrayFieldModel, fieldModel, shapeFieldModel } from "@virentia/forms/models";
import { action, component, For, h, hydrate, type Readable } from "@virentia/ui";
import { renderToString } from "@virentia/ui/server";

it("hydrates nested owned array/shape fields onto server DOM and keeps validation and disposal isolated", async () => {
  const Email = fieldModel("", {
    name: "HydratedContactEmail", validate: value => value.includes("@") ? null : "Invalid email",
  });
  const Phones = arrayFieldModel(["000"], { name: "HydratedContactPhones" });
  const Contact = shapeFieldModel({ email: Email, phones: Phones }, { name: "HydratedContact" });
  const Contacts = arrayFieldModel([{ email: "seed@example.com", phones: ["000"] }], {
    item: Contact, name: "HydratedContacts",
  });
  const Profile = staticModel({
    name: "HydratedNestedProfile",
    data: { contacts: children.one(Contacts) },
    setup(self) {
      const form = createForm({
        schema: () => ({ contacts: self.contacts.value!.field }),
        validation: values => ({ contacts: values.contacts.map(contact => ({
          email: contact.email.includes("@") ? null : "Invalid email",
        })) }),
        validationStrategies: ["change"],
      });
      return {
        form,
        valuesText: computed(() => JSON.stringify(form.values.value)),
        validText: computed(() => form.isValid.value ? "valid" : "invalid"),
        input: action((event: Event) => {
          const target = event.target as HTMLInputElement;
          return self.contacts.value!.field.items.value[Number(target.dataset.index)]!
            .fields.value.email.fill(target.value);
        }),
      };
    },
    onCreate(self) { if (!self.contacts.value) self.contacts.create({}); },
  });
  type ContactField = InstanceOf<typeof Contact>["field"];
  type PhoneField = ContactField["fields"]["value"]["phones"]["items"]["value"][number];
  const View = component({
    model: Profile,
    view(_props, self) {
      return h("section", null,
        h("output", { "data-values": "" }, self.model.valuesText),
        h("output", { "data-valid": "" }, self.model.validText),
        h("ol", { "data-contacts": "" }, h(For, {
          each: self.model.contacts.value!.field.items,
          view: (item: Readable<ContactField>, index: Readable<number>) => {
            const fields = item.value.fields.value;
            return h("li", { "data-contact": "" },
              h("input", {
                "data-email": "", "data-index": index, value: fields.email.state,
                onInput: self.model.input,
              }),
              h("ul", null, h(For, {
                each: fields.phones.items,
                view: (phone: Readable<PhoneField>) => h("li", { "data-phone": "" }, phone.value.state),
              })),
            );
          },
        })),
      );
    },
  });
  const server = scope(), serverProfile = scoped(server, () => Profile.create({ id: "profile" }));
  await serverProfile.form.fill({ values: { contacts: [
    { email: "first@example.com", phones: ["111", "222"] },
    { email: "second@example.com", phones: [] },
  ] } });
  await serverProfile.contacts.value!.field.move(1, 0);
  const html = renderToString(() => h(View, { model: serverProfile }), {
    scope: server, identifierPrefix: "nested-fields",
  });
  const payload = { dto: serverProfile.json(), snapshot: serialize(server) };
  const received = JSON.parse(JSON.stringify(payload)) as typeof payload;
  const client = scope({ snapshot: received.snapshot });
  const profile = scoped(client, () => Profile.create(received.dto));
  const sibling = scoped(client, () => Profile.create({ id: "sibling" }));
  const independent = scoped(scope(), () => Profile.create({ id: "profile" }));
  const host = document.createElement("div");
  host.innerHTML = html; document.body.append(host);
  const rows = [...host.querySelectorAll("[data-contact]")];
  const inputs = [...host.querySelectorAll<HTMLInputElement>("[data-email]")];
  const phones = [...host.querySelectorAll("[data-phone]")];
  const output = host.querySelector("[data-values]")!;
  const errors = vi.spyOn(console, "error");
  let detach: ReturnType<typeof hydrate> | undefined;
  try {
    detach = hydrate(() => h(View, { model: profile }), host, {
      scope: client, identifierPrefix: "nested-fields",
    });
    for (const [selector, existing] of [["[data-contact]", rows], ["[data-email]", inputs], ["[data-phone]", phones]] as const) {
      const hydrated = [...host.querySelectorAll(selector)];
      expect(hydrated).toHaveLength(existing.length);
      existing.forEach((node, index) => expect(hydrated[index]).toBe(node));
    }
    expect(host.querySelector("[data-values]")).toBe(output);
    expect(inputs.map(input => input.value)).toEqual(["second@example.com", "first@example.com"]);
    expect(output.textContent).toBe(JSON.stringify(serverProfile.form.values.value));
    expect(errors).not.toHaveBeenCalled();

    inputs[0]!.value = "invalid";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(profile.form.values.value.contacts[0]!.email).toBe("invalid");
      const error = profile.form.errors.value.contacts?.[0];
      expect(typeof error === "object" && error?.email).toBe("Invalid email");
      expect(host.querySelector("[data-valid]")!.textContent).toBe("invalid");
      expect(profile.form.isValidationPending.value).toBe(false);
    });
    expect(host.querySelector("[data-email]")).toBe(inputs[0]);
    expect(serverProfile.form.values.value.contacts[0]!.email).toBe("second@example.com");
    expect(sibling.form.values.value.contacts[0]!.email).toBe("seed@example.com");
    expect(independent.form.values.value.contacts[0]!.email).toBe("seed@example.com");

    await profile.contacts.value!.field.items.value[0]!.fields.value.phones.push("333");
    expect(rows[0]!.querySelector("[data-phone]")!.textContent).toBe("333");
    const removed = profile.contacts.value!.field.items.value[1]!;
    await profile.contacts.value!.field.move(1, 0);
    // Field.items is an array-valued store. Native For deliberately recreates
    // rows on whole-array replacement; node reuse is asserted at hydration.
    expect([...host.querySelectorAll<HTMLInputElement>("[data-email]")].map(input => input.value))
      .toEqual(["first@example.com", "invalid"]);
    expect([...host.querySelectorAll("[data-phone]")].map(phone => phone.textContent))
      .toEqual(["111", "222", "333"]);
    await profile.contacts.value!.field.remove(0);
    expect(host.querySelectorAll("[data-contact]")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>("[data-email]")!.value).toBe("invalid");
    expect(() => removed.state.value).toThrow(/disposed/);

    await profile.form.reset();
    await vi.waitFor(() => expect(host.querySelector("[data-valid]")!.textContent).toBe("valid"));
    expect(profile.form.values.value).toEqual({ contacts: [{ email: "seed@example.com", phones: ["000"] }] });
    expect(host.querySelector<HTMLInputElement>("[data-email]")!.value).toBe("seed@example.com");
    expect(host.querySelector("[data-phone]")!.textContent).toBe("000");
    expect(serverProfile.form.values.value.contacts).toHaveLength(2);

    const retainedInput = host.querySelector<HTMLInputElement>("[data-email]")!;
    const retainedField = profile.contacts.value!.field.items.value[0]!.fields.value.email;
    await detach(); detach = undefined;
    expect(profile.alive).toBe(true);
    retainedInput.value = "detached@example.com";
    retainedInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(retainedField.state.value).toBe("seed@example.com");
    await profile.dispose();
    expect(() => retainedField.state.value).toThrow(/disposed/);
    await sibling.form.fill({ values: { contacts: [{ email: "live@example.com", phones: [] }] } });
    expect(sibling.form.values.value.contacts[0]!.email).toBe("live@example.com");
    const fresh = scoped(client, () => Profile.create({ id: "profile" }));
    try {
      expect(fresh.form.values.value).toEqual({ contacts: [{ email: "seed@example.com", phones: ["000"] }] });
    } finally { await fresh.dispose(); }
    expect(errors).not.toHaveBeenCalled();
  } finally {
    try { await detach?.(); }
    finally {
      errors.mockRestore(); host.remove();
      await profile.dispose(); await sibling.dispose(); await independent.dispose(); await serverProfile.dispose();
    }
  }
});
