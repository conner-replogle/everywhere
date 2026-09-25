#ifndef EVERYWHERE_DESKTOP_CAPTURE_H
#define EVERYWHERE_DESKTOP_CAPTURE_H

#include <stddef.h>
#include <stdint.h>

typedef struct oc_capture oc_capture;

enum { OC_CODEC_H264 = 0, OC_CODEC_H265 = 1, OC_CODEC_AV1 = 2 };

typedef struct {
	const char *output;   /* wl_output name; NULL or "" picks eDP-1, else the first output */
	const char *window;   /* ext-foreign-toplevel identifier (Hyprland's stableId) to capture instead of output */
	int bitrate_kbps;
	int paint_cursor;
	int target_usage;     /* VA target-usage: 1 (quality) .. 7 (speed) */
	int codec;            /* OC_CODEC_* */
	int width, height;    /* encoded size; 0 = native */
	int max_fps;          /* 0 = as fast as the output changes */
} oc_config;

typedef struct {
	uint8_t *data;
	size_t len;
	int64_t capture_us;   /* CLOCK_MONOTONIC when the frame was presented on the host */
	int keyframe;
} oc_sample;

/* Sets up Wayland capture and the encode pipeline, then starts the capture thread. */
oc_capture *oc_capture_start(const oc_config *cfg, char *err, size_t errlen);
/* 1 = sample written to out, 0 = timeout, -1 = closed or failed (see oc_capture_error). */
int oc_capture_pull(oc_capture *c, int timeout_ms, oc_sample *out);
void oc_sample_free(oc_sample *s);
void oc_capture_request_keyframe(oc_capture *c);
void oc_capture_set_bitrate(oc_capture *c, int kbps);
/* Non-blocking; makes pull return -1. */
void oc_capture_close(oc_capture *c);
/* Joins the capture thread and releases everything. Pull must not be running. */
void oc_capture_free(oc_capture *c);
const char *oc_capture_error(oc_capture *c);
int oc_capture_width(oc_capture *c);
int oc_capture_height(oc_capture *c);
const char *oc_capture_output(oc_capture *c);
typedef struct {
	uint64_t img_gen, pos_gen;
	int inside;           /* cursor intersects the captured output */
	int x, y;             /* hotspot position in output buffer pixels */
	int hot_x, hot_y;
	int width, height;
	uint8_t *rgba;        /* set only when the image changed; caller frees */
} oc_cursor;

/* Only with paint_cursor = 0. Waits until the cursor image or position differs from the given
 * generations. 1 = changed (out filled), 0 = timeout, -1 = closed. */
int oc_capture_cursor_wait(oc_capture *c, uint64_t img_gen, uint64_t pos_gen, int timeout_ms, oc_cursor *out);

/* Newline-separated "name\twidth\theight" of all outputs; caller frees. NULL on error. */
char *oc_list_outputs(char *err, size_t errlen);

#endif
