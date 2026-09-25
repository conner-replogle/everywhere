//go:build linux && cgo

#define _GNU_SOURCE
#include "input.h"

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <linux/input-event-codes.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "proto-virtual-keyboard-unstable-v1.h"
#include "proto-wlr-virtual-pointer-unstable-v1.h"

#define MAX_OUTPUTS 16
#define EXTENT 65535
#define KEY_SLOTS 768
#define BUTTON_SLOTS 16 /* BTN_MOUSE .. BTN_MOUSE+15 */
/* Wayland scroll units per wheel notch, matching libinput's default. */
#define WHEEL_STEP 15.0

struct output {
	struct wl_output *wl;
	char name[64];
};

struct oi_input {
	pthread_mutex_t mu;
	struct wl_display *dpy;
	struct wl_registry *reg;
	struct wl_seat *seat;
	struct output outputs[MAX_OUTPUTS];
	int noutputs;
	struct zwlr_virtual_pointer_manager_v1 *ptrmgr;
	uint32_t ptrmgr_version;
	struct zwp_virtual_keyboard_manager_v1 *kbdmgr;

	struct zwlr_virtual_pointer_v1 *pointer;
	struct zwp_virtual_keyboard_v1 *keyboard;

	struct xkb_context *xkb;
	struct xkb_keymap *keymap;
	struct xkb_state *state;
	xkb_mod_mask_t last_depressed, last_latched, last_locked;
	xkb_layout_index_t last_group;

	uint8_t keys[KEY_SLOTS];
	uint8_t buttons[BUTTON_SLOTS];
	int broken;
};

static void set_err(char *buf, size_t len, const char *fmt, ...) {
	if (!buf || !len) return;
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, len, fmt, ap);
	va_end(ap);
}

static uint32_t now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph,
	int32_t sp, const char *make, const char *model, int32_t transform) {}
static void output_mode(void *d, struct wl_output *o, uint32_t f, int32_t w, int32_t h, int32_t r) {}
static void output_done(void *d, struct wl_output *o) {}
static void output_scale(void *d, struct wl_output *o, int32_t f) {}
static void output_name(void *d, struct wl_output *o, const char *name) {
	snprintf(((struct output *)d)->name, sizeof ((struct output *)d)->name, "%s", name);
}
static void output_description(void *d, struct wl_output *o, const char *desc) {}
static const struct wl_output_listener output_listener = {
	output_geometry, output_mode, output_done, output_scale, output_name, output_description,
};

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
	struct oi_input *in = data;
	if (strcmp(iface, wl_seat_interface.name) == 0 && !in->seat) {
		in->seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
	} else if (strcmp(iface, wl_output_interface.name) == 0 && version >= 4 && in->noutputs < MAX_OUTPUTS) {
		struct output *out = &in->outputs[in->noutputs++];
		out->wl = wl_registry_bind(reg, name, &wl_output_interface, 4);
		wl_output_add_listener(out->wl, &output_listener, out);
	} else if (strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
		in->ptrmgr_version = version < 2 ? version : 2;
		in->ptrmgr = wl_registry_bind(reg, name, &zwlr_virtual_pointer_manager_v1_interface, in->ptrmgr_version);
	} else if (strcmp(iface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
		in->kbdmgr = wl_registry_bind(reg, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
	}
}
static void registry_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

static int upload_keymap(struct oi_input *in, char *err, size_t errlen) {
	char *str = xkb_keymap_get_as_string(in->keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
	if (!str) { set_err(err, errlen, "xkb_keymap_get_as_string failed"); return -1; }
	size_t size = strlen(str) + 1;
	int fd = memfd_create("everywhere-keymap", MFD_CLOEXEC | MFD_ALLOW_SEALING);
	if (fd < 0 || ftruncate(fd, size) < 0) { free(str); set_err(err, errlen, "memfd: %s", strerror(errno)); return -1; }
	char *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (map == MAP_FAILED) { free(str); close(fd); set_err(err, errlen, "mmap: %s", strerror(errno)); return -1; }
	memcpy(map, str, size);
	munmap(map, size);
	free(str);
	zwp_virtual_keyboard_v1_keymap(in->keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, size);
	close(fd);
	return 0;
}

/* Must hold mu. Flushes requests and drains incoming events without blocking. */
static int sync_out(struct oi_input *in) {
	if (in->broken) return -1;
	while (wl_display_prepare_read(in->dpy) != 0) wl_display_dispatch_pending(in->dpy);
	struct pollfd pfd = { wl_display_get_fd(in->dpy), POLLIN, 0 };
	if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
		if (wl_display_read_events(in->dpy) < 0) { in->broken = 1; return -1; }
	} else {
		wl_display_cancel_read(in->dpy);
	}
	if (wl_display_dispatch_pending(in->dpy) < 0 || wl_display_flush(in->dpy) < 0) {
		if (errno != EAGAIN) { in->broken = 1; return -1; }
	}
	return 0;
}

oi_input *oi_open(const oi_config *cfg, char *err, size_t errlen) {
	struct oi_input *in = calloc(1, sizeof *in);
	pthread_mutex_init(&in->mu, NULL);

	in->dpy = wl_display_connect(NULL);
	if (!in->dpy) { set_err(err, errlen, "cannot connect to Wayland display"); goto fail; }
	in->reg = wl_display_get_registry(in->dpy);
	wl_registry_add_listener(in->reg, &registry_listener, in);
	wl_display_roundtrip(in->dpy);
	wl_display_roundtrip(in->dpy);
	if (!in->seat) { set_err(err, errlen, "no wl_seat"); goto fail; }
	if (!in->ptrmgr) { set_err(err, errlen, "compositor lacks wlr-virtual-pointer-unstable-v1"); goto fail; }
	if (!in->kbdmgr) { set_err(err, errlen, "compositor lacks virtual-keyboard-unstable-v1"); goto fail; }

	struct output *out = NULL;
	const char *want = (cfg->output && *cfg->output) ? cfg->output : "eDP-1";
	for (int i = 0; i < in->noutputs; i++)
		if (strcmp(in->outputs[i].name, want) == 0) out = &in->outputs[i];
	if (!out && in->noutputs) out = &in->outputs[0];

	if (out && in->ptrmgr_version >= 2)
		in->pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(in->ptrmgr, in->seat, out->wl);
	else
		in->pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(in->ptrmgr, in->seat);

	in->xkb = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	struct xkb_rule_names names = {
		.rules = cfg->rules && *cfg->rules ? cfg->rules : NULL,
		.model = cfg->model && *cfg->model ? cfg->model : NULL,
		.layout = cfg->layout && *cfg->layout ? cfg->layout : NULL,
		.variant = cfg->variant && *cfg->variant ? cfg->variant : NULL,
		.options = cfg->options && *cfg->options ? cfg->options : NULL,
	};
	in->keymap = xkb_keymap_new_from_names(in->xkb, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
	if (!in->keymap) { set_err(err, errlen, "cannot compile XKB keymap (layout %s)", names.layout ? names.layout : "default"); goto fail; }
	in->state = xkb_state_new(in->keymap);

	in->keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(in->kbdmgr, in->seat);
	if (upload_keymap(in, err, errlen) < 0) goto fail;

	wl_display_roundtrip(in->dpy);
	if (wl_display_get_error(in->dpy)) { set_err(err, errlen, "compositor rejected virtual input devices (error %d)", wl_display_get_error(in->dpy)); goto fail; }
	return in;
fail:
	oi_close(in);
	return NULL;
}

int oi_motion(oi_input *in, uint32_t x, uint32_t y) {
	pthread_mutex_lock(&in->mu);
	if (x > EXTENT) x = EXTENT;
	if (y > EXTENT) y = EXTENT;
	zwlr_virtual_pointer_v1_motion_absolute(in->pointer, now_ms(), x, y, EXTENT, EXTENT);
	zwlr_virtual_pointer_v1_frame(in->pointer);
	int r = sync_out(in);
	pthread_mutex_unlock(&in->mu);
	return r;
}

int oi_button(oi_input *in, uint32_t button, int pressed) {
	if (button < BTN_MOUSE || button >= BTN_MOUSE + BUTTON_SLOTS) return 0;
	pthread_mutex_lock(&in->mu);
	int r = 0;
	uint8_t *slot = &in->buttons[button - BTN_MOUSE];
	if (*slot != !!pressed) {
		*slot = !!pressed;
		zwlr_virtual_pointer_v1_button(in->pointer, now_ms(), button,
			pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
		zwlr_virtual_pointer_v1_frame(in->pointer);
		r = sync_out(in);
	}
	pthread_mutex_unlock(&in->mu);
	return r;
}

static void send_axis(struct oi_input *in, uint32_t t, uint32_t axis, int continuous, double v) {
	if (v == 0) return;
	if (continuous) {
		zwlr_virtual_pointer_v1_axis(in->pointer, t, axis, wl_fixed_from_double(v));
	} else {
		int steps = (int)(v > 0 ? v + 0.5 : v - 0.5);
		if (steps == 0) steps = v > 0 ? 1 : -1;
		zwlr_virtual_pointer_v1_axis_discrete(in->pointer, t, axis, wl_fixed_from_double(steps * WHEEL_STEP), steps);
	}
}

/* continuous: dx/dy are pixels (touchpad-like). Otherwise they are wheel notches. */
int oi_axis(oi_input *in, int continuous, double dx, double dy) {
	pthread_mutex_lock(&in->mu);
	uint32_t t = now_ms();
	zwlr_virtual_pointer_v1_axis_source(in->pointer,
		continuous ? WL_POINTER_AXIS_SOURCE_FINGER : WL_POINTER_AXIS_SOURCE_WHEEL);
	send_axis(in, t, WL_POINTER_AXIS_VERTICAL_SCROLL, continuous, dy);
	send_axis(in, t, WL_POINTER_AXIS_HORIZONTAL_SCROLL, continuous, dx);
	zwlr_virtual_pointer_v1_frame(in->pointer);
	int r = sync_out(in);
	pthread_mutex_unlock(&in->mu);
	return r;
}

/* Must hold mu. Virtual keyboards report their own modifier state to the compositor. */
static void update_modifiers(struct oi_input *in) {
	xkb_mod_mask_t dep = xkb_state_serialize_mods(in->state, XKB_STATE_MODS_DEPRESSED);
	xkb_mod_mask_t lat = xkb_state_serialize_mods(in->state, XKB_STATE_MODS_LATCHED);
	xkb_mod_mask_t loc = xkb_state_serialize_mods(in->state, XKB_STATE_MODS_LOCKED);
	xkb_layout_index_t grp = xkb_state_serialize_layout(in->state, XKB_STATE_LAYOUT_EFFECTIVE);
	if (dep == in->last_depressed && lat == in->last_latched && loc == in->last_locked && grp == in->last_group) return;
	in->last_depressed = dep;
	in->last_latched = lat;
	in->last_locked = loc;
	in->last_group = grp;
	zwp_virtual_keyboard_v1_modifiers(in->keyboard, dep, lat, loc, grp);
}

int oi_key(oi_input *in, uint32_t key, int pressed) {
	if (key == 0 || key >= KEY_SLOTS) return 0;
	pthread_mutex_lock(&in->mu);
	int r = 0;
	if (in->keys[key] != !!pressed) {
		in->keys[key] = !!pressed;
		zwp_virtual_keyboard_v1_key(in->keyboard, now_ms(), key,
			pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
		xkb_state_update_key(in->state, key + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
		update_modifiers(in);
		r = sync_out(in);
	}
	pthread_mutex_unlock(&in->mu);
	return r;
}

int oi_release_all(oi_input *in) {
	pthread_mutex_lock(&in->mu);
	uint32_t t = now_ms();
	for (uint32_t k = 0; k < KEY_SLOTS; k++) {
		if (!in->keys[k]) continue;
		in->keys[k] = 0;
		zwp_virtual_keyboard_v1_key(in->keyboard, t, k, WL_KEYBOARD_KEY_STATE_RELEASED);
		xkb_state_update_key(in->state, k + 8, XKB_KEY_UP);
	}
	update_modifiers(in);
	int any = 0;
	for (uint32_t b = 0; b < BUTTON_SLOTS; b++) {
		if (!in->buttons[b]) continue;
		in->buttons[b] = 0;
		any = 1;
		zwlr_virtual_pointer_v1_button(in->pointer, t, BTN_MOUSE + b, WL_POINTER_BUTTON_STATE_RELEASED);
	}
	if (any) zwlr_virtual_pointer_v1_frame(in->pointer);
	int r = sync_out(in);
	pthread_mutex_unlock(&in->mu);
	return r;
}

void oi_close(oi_input *in) {
	if (!in) return;
	if (in->dpy && !in->broken && in->pointer && in->keyboard) oi_release_all(in);
	if (in->pointer) zwlr_virtual_pointer_v1_destroy(in->pointer);
	if (in->keyboard) zwp_virtual_keyboard_v1_destroy(in->keyboard);
	if (in->state) xkb_state_unref(in->state);
	if (in->keymap) xkb_keymap_unref(in->keymap);
	if (in->xkb) xkb_context_unref(in->xkb);
	for (int i = 0; i < in->noutputs; i++) wl_output_release(in->outputs[i].wl);
	if (in->seat) wl_seat_destroy(in->seat);
	if (in->ptrmgr) zwlr_virtual_pointer_manager_v1_destroy(in->ptrmgr);
	if (in->kbdmgr) wl_proxy_destroy((struct wl_proxy *)in->kbdmgr);
	if (in->reg) wl_registry_destroy(in->reg);
	if (in->dpy) {
		wl_display_flush(in->dpy);
		wl_display_disconnect(in->dpy);
	}
	pthread_mutex_destroy(&in->mu);
	free(in);
}
