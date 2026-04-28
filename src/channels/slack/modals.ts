export interface ModalField {
  name: string;
  type: "text" | "textarea" | "select" | "email" | "url" | "number" | "datepicker";
}

export function parseModalDirective(raw: string): { title: string; fields: ModalField[] } {
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx <= 0) return { title: raw.trim(), fields: [] };
  const title = raw.slice(0, pipeIdx).trim();
  const fieldsPart = raw.slice(pipeIdx + 1);
  const fields = fieldsPart.split(",").map((part) => {
    const trimmed = part.trim();
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx <= 0) return { name: trimmed, type: "text" as const };
    return {
      name: trimmed.slice(0, colonIdx).trim(),
      type: trimmed.slice(colonIdx + 1).trim() as ModalField["type"],
    };
  });
  return { title, fields };
}

const INPUT_TYPE_MAP: Record<string, string> = {
  text: "plain_text_input",
  textarea: "plain_text_input",
  email: "email_text_input",
  url: "url_text_input",
  number: "number_input",
  datepicker: "datepicker",
  select: "static_select",
};

export function buildModalView(title: string, fields: ModalField[], callbackId: string): any {
  return {
    type: "modal",
    callback_id: `nyxhive:modal_submit:${callbackId}`,
    title: { type: "plain_text", text: title.slice(0, 24) },
    submit: { type: "plain_text", text: "Submit" },
    blocks: fields.map((field, i) => ({
      type: "input",
      block_id: `field_${i}`,
      label: { type: "plain_text", text: field.name },
      element: {
        type: INPUT_TYPE_MAP[field.type] ?? "plain_text_input",
        action_id: `nyxhive:modal_field:${i}`,
        ...(field.type === "textarea" ? { multiline: true } : {}),
      },
    })),
  };
}
