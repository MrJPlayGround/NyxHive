interface MenuOption {
  label: string;
  value: string;
}

export function renderArgMenu(prompt: string, options: MenuOption[], actionPrefix: string): any[] {
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: prompt } },
  ];

  if (options.length <= 5) {
    blocks.push({
      type: "actions",
      elements: options.map((opt, i) => ({
        type: "button",
        text: { type: "plain_text", text: opt.label },
        action_id: `nyxhive:arg_menu:${actionPrefix}:${i}`,
        value: opt.value,
      })),
    });
  } else {
    blocks.push({
      type: "actions",
      elements: [{
        type: "static_select",
        placeholder: { type: "plain_text", text: "Choose..." },
        action_id: `nyxhive:arg_menu:${actionPrefix}`,
        options: options.slice(0, 100).map((opt) => ({
          text: { type: "plain_text", text: opt.label },
          value: opt.value,
        })),
      }],
    });
  }

  return blocks;
}
