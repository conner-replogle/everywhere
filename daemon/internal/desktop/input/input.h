#ifndef EVERYWHERE_DESKTOP_INPUT_H
#define EVERYWHERE_DESKTOP_INPUT_H

#include <stddef.h>
#include <stdint.h>

typedef struct oi_input oi_input;

typedef struct {
	const char *output;   /* wl_output the absolute pointer maps onto; NULL = eDP-1 / first */
	const char *rules, *model, *layout, *variant, *options; /* XKB RMLVO for the uploaded keymap */
} oi_config;

oi_input *oi_open(const oi_config *cfg, char *err, size_t errlen);
/* All calls return 0, or -1 once the Wayland connection is unusable. */
int oi_motion(oi_input *in, uint32_t x, uint32_t y); /* 0..65535 across the output */
int oi_button(oi_input *in, uint32_t button, int pressed); /* linux BTN_* code */
int oi_axis(oi_input *in, int continuous, double dx, double dy);
int oi_key(oi_input *in, uint32_t key, int pressed); /* linux KEY_* code */
int oi_release_all(oi_input *in);
void oi_close(oi_input *in);

#endif
