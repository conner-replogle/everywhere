package capture

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	iidIDXGIFactory1       = guid(0x770aae78, 0xf26f, 0x4dba, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87)
	iidIDXGIOutput1        = guid(0x00cddea8, 0x939b, 0x4b83, 0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc)
	iidID3D11Texture2D     = guid(0x6f15aaf2, 0xd208, 0x4e89, 0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c)
	iidID3D11VideoDevice   = guid(0x10ec4d5b, 0x975a, 0x4689, 0xb9, 0xe4, 0xd0, 0xaa, 0xc3, 0x0f, 0xe3, 0x33)
	iidID3D11VideoContext  = guid(0x61f21c45, 0x3c0e, 0x4a74, 0x9c, 0xea, 0x67, 0x10, 0x0d, 0x9a, 0xd5, 0xe4)
	iidID3D10Multithread   = guid(0x9b7e4e00, 0x342c, 0x4106, 0xa1, 0x9f, 0x4f, 0x27, 0x04, 0xf6, 0x89, 0xf0)
	iidIMFDXGIDeviceManger = guid(0xeb533d5d, 0x2db6, 0x40f8, 0x97, 0xa9, 0x49, 0x46, 0x92, 0x01, 0x4f, 0x07)
)

// Vtable indices (Windows SDK headers).
const (
	factoryEnumAdapters1 = 12
	adapterEnumOutputs   = 7
	outputGetDesc        = 7
	outputDuplicate      = 22

	duplGetDesc         = 7
	duplAcquireNext     = 8
	duplGetPointerShape = 11
	duplReleaseFrame    = 14

	deviceCreateTexture2D = 5

	contextMap          = 14
	contextUnmap        = 15
	contextCopyResource = 47
	contextFlush        = 111

	textureGetDesc = 10

	multithreadSetProtected = 5

	videoDeviceCreateProcessor   = 4
	videoDeviceCreateInputView   = 8
	videoDeviceCreateOutputView  = 9
	videoDeviceCreateEnumerator  = 10
	videoContextSetOutputRect    = 13
	videoContextSetOutColorSpace = 15
	videoContextSetFrameFormat   = 27
	videoContextSetInColorSpace  = 28
	videoContextSetSourceRect    = 30
	videoContextSetDestRect      = 31
	videoContextSetAutoProcess   = 37
	videoContextBlt              = 53
)

const (
	formatB8G8R8A8 = 87
	formatNV12     = 103

	bindShaderResource = 0x8
	bindRenderTarget   = 0x20

	usageDefault = 0
	usageStaging = 3
	cpuRead      = 0x20000
	mapRead      = 1
)

type rect struct{ Left, Top, Right, Bottom int32 }

type outputDesc struct {
	DeviceName [32]uint16
	Desktop    rect
	Attached   int32
	Rotation   uint32
	Monitor    uintptr
}

type duplDesc struct {
	Width, Height    uint32
	RefreshN         uint32
	RefreshD         uint32
	Format           uint32
	ScanlineOrdering uint32
	Scaling          uint32
	Rotation         uint32
	InSystemMemory   int32
}

type frameInfo struct {
	LastPresentTime     int64
	LastMouseUpdateTime int64
	AccumulatedFrames   uint32
	RectsCoalesced      int32
	ProtectedMasked     int32
	PointerX, PointerY  int32
	PointerVisible      int32
	MetadataSize        uint32
	PointerShapeSize    uint32
}

type pointerShapeInfo struct {
	Type, Width, Height, Pitch uint32
	HotX, HotY                 int32
}

type texture2DDesc struct {
	Width, Height, MipLevels, ArraySize, Format uint32
	SampleCount, SampleQuality                  uint32
	Usage, BindFlags, CPUAccess, Misc           uint32
}

type mappedSubresource struct {
	Data       uintptr
	RowPitch   uint32
	DepthPitch uint32
}

// gpu is a D3D11 device on the adapter that drives one output, duplicating
// that output.
type gpu struct {
	device, context iface
	output          iface // IDXGIOutput1
	dupl            iface
	desc            outputDesc
	width, height   int // the desktop image's size
}

// openGPU finds the DXGI output for device (\\.\DISPLAY1) and makes a device
// on its adapter.
func openGPU(device string) (*gpu, error) {
	var factory iface
	if err := callProc(procCreateDXGIFactory1, uintptr(unsafe.Pointer(&iidIDXGIFactory1)), uintptr(unsafe.Pointer(&factory))); err != nil {
		return nil, err
	}
	defer factory.release()
	for a := 0; ; a++ {
		var adapter iface
		if err := factory.hcall("EnumAdapters1", factoryEnumAdapters1, uintptr(a), uintptr(unsafe.Pointer(&adapter))); err != nil {
			if is(err, dxgiErrorNotFound) {
				return nil, fmt.Errorf("no display %s found for capture", device)
			}
			return nil, err
		}
		for o := 0; ; o++ {
			var output iface
			if err := adapter.hcall("EnumOutputs", adapterEnumOutputs, uintptr(o), uintptr(unsafe.Pointer(&output))); err != nil {
				break
			}
			var desc outputDesc
			_ = output.hcall("GetDesc", outputGetDesc, uintptr(unsafe.Pointer(&desc)))
			if windows.UTF16ToString(desc.DeviceName[:]) != device {
				output.release()
				continue
			}
			g, err := newGPU(adapter, output, desc)
			output.release()
			adapter.release()
			return g, err
		}
		adapter.release()
	}
}

func newGPU(adapter, output iface, desc outputDesc) (*gpu, error) {
	const (
		driverUnknown = 0
		bgraSupport   = 0x20
		videoSupport  = 0x800
		sdkVersion    = 7
	)
	g := &gpu{desc: desc}
	var level uint32
	if err := callProc(procD3D11CreateDevice, uintptr(adapter), driverUnknown, 0, bgraSupport|videoSupport, 0, 0, sdkVersion,
		uintptr(unsafe.Pointer(&g.device)), uintptr(unsafe.Pointer(&level)), uintptr(unsafe.Pointer(&g.context))); err != nil {
		return nil, fmt.Errorf("creating the Direct3D device: %w", err)
	}
	// Media Foundation uses the device from its own threads.
	if mt, err := g.device.queryInterface(&iidID3D10Multithread); err == nil {
		mt.call(multithreadSetProtected, 1)
		mt.release()
	}
	o1, err := output.queryInterface(&iidIDXGIOutput1)
	if err != nil {
		g.close()
		return nil, err
	}
	g.output = o1
	if err := g.duplicate(); err != nil {
		g.close()
		return nil, err
	}
	return g, nil
}

// duplicate (re)starts duplicating the output: after a mode change or a trip
// to the secure desktop, the old duplication is lost.
func (g *gpu) duplicate() error {
	g.dupl.release()
	g.dupl = 0
	if err := g.output.hcall("DuplicateOutput", outputDuplicate, uintptr(g.device), uintptr(unsafe.Pointer(&g.dupl))); err != nil {
		if is(err, eAccessDenied) {
			return fmt.Errorf("the screen can't be captured right now (it's locked, or a UAC prompt is up): %w", err)
		}
		return err
	}
	var d duplDesc
	g.dupl.call(duplGetDesc, uintptr(unsafe.Pointer(&d)))
	g.width, g.height = int(d.Width), int(d.Height)
	return nil
}

func (g *gpu) close() {
	g.dupl.release()
	g.output.release()
	g.context.release()
	g.device.release()
}

func (g *gpu) texture(w, h int, format, bind uint32) (iface, error) {
	d := texture2DDesc{Width: uint32(w), Height: uint32(h), MipLevels: 1, ArraySize: 1, Format: format, SampleCount: 1, Usage: usageDefault, BindFlags: bind}
	var t iface
	err := g.device.hcall("CreateTexture2D", deviceCreateTexture2D, uintptr(unsafe.Pointer(&d)), 0, uintptr(unsafe.Pointer(&t)))
	return t, err
}

func (g *gpu) stagingTexture(w, h int, format uint32) (iface, error) {
	d := texture2DDesc{Width: uint32(w), Height: uint32(h), MipLevels: 1, ArraySize: 1, Format: format, SampleCount: 1, Usage: usageStaging, CPUAccess: cpuRead}
	var t iface
	err := g.device.hcall("CreateTexture2D", deviceCreateTexture2D, uintptr(unsafe.Pointer(&d)), 0, uintptr(unsafe.Pointer(&t)))
	return t, err
}

func textureSize(t iface) (int, int) {
	var d texture2DDesc
	t.call(textureGetDesc, uintptr(unsafe.Pointer(&d)))
	return int(d.Width), int(d.Height)
}

// converter scales and converts the BGRA desktop to NV12 on the GPU.
type converter struct {
	g          *gpu
	vdev, vctx iface
	enum, vp   iface
	in         iface // input view of src
	src        iface // BGRA, the desktop's size
	outs       []nv12Target
	next       int
	w, h       int // output size
}

type nv12Target struct {
	tex, view iface
}

type contentDesc struct {
	InputFrameFormat   uint32
	InRateN, InRateD   uint32
	InputW, InputH     uint32
	OutRateN, OutRateD uint32
	OutputW, OutputH   uint32
	Usage              uint32
}

type viewDesc struct {
	A, B, C, D uint32
}

type vpStream struct {
	Enable                 int32
	OutputIndex            uint32
	InputFrameOrField      uint32
	PastFrames             uint32
	FutureFrames           uint32
	_                      uint32
	PastSurfaces           uintptr
	InputSurface           uintptr
	FutureSurfaces         uintptr
	PastSurfacesRight      uintptr
	InputSurfaceRight      uintptr
	FutureSurfacesRightPtr uintptr
}

// nv12Ring is how many NV12 frames can be with the encoder at once.
const nv12Ring = 6

func newConverter(g *gpu, src iface, srcW, srcH, w, h int) (*converter, error) {
	c := &converter{g: g, src: src, w: w, h: h}
	var err error
	if c.vdev, err = g.device.queryInterface(&iidID3D11VideoDevice); err != nil {
		return nil, fmt.Errorf("the GPU has no video processor: %w", err)
	}
	if c.vctx, err = g.context.queryInterface(&iidID3D11VideoContext); err != nil {
		c.close()
		return nil, err
	}
	cd := contentDesc{InRateN: 60, InRateD: 1, InputW: uint32(srcW), InputH: uint32(srcH), OutRateN: 60, OutRateD: 1, OutputW: uint32(w), OutputH: uint32(h)}
	if err := c.vdev.hcall("CreateVideoProcessorEnumerator", videoDeviceCreateEnumerator, uintptr(unsafe.Pointer(&cd)), uintptr(unsafe.Pointer(&c.enum))); err != nil {
		c.close()
		return nil, err
	}
	if err := c.vdev.hcall("CreateVideoProcessor", videoDeviceCreateProcessor, uintptr(c.enum), 0, uintptr(unsafe.Pointer(&c.vp))); err != nil {
		c.close()
		return nil, err
	}
	in := viewDesc{B: 1} // FourCC 0, D3D11_VPIV_DIMENSION_TEXTURE2D, mip 0, slice 0
	if err := c.vdev.hcall("CreateVideoProcessorInputView", videoDeviceCreateInputView, uintptr(src), uintptr(c.enum), uintptr(unsafe.Pointer(&in)), uintptr(unsafe.Pointer(&c.in))); err != nil {
		c.close()
		return nil, err
	}
	for range nv12Ring {
		t, err := g.texture(w, h, formatNV12, bindRenderTarget)
		if err != nil {
			c.close()
			return nil, fmt.Errorf("creating an NV12 texture: %w", err)
		}
		out := viewDesc{A: 1} // D3D11_VPOV_DIMENSION_TEXTURE2D, mip 0
		var v iface
		if err := c.vdev.hcall("CreateVideoProcessorOutputView", videoDeviceCreateOutputView, uintptr(t), uintptr(c.enum), uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&v))); err != nil {
			t.release()
			c.close()
			return nil, err
		}
		c.outs = append(c.outs, nv12Target{t, v})
	}
	// RGB in full range; BT.709 limited-range YCbCr out, as the encoder's
	// stream says. D3D11_VIDEO_PROCESSOR_COLOR_SPACE is a bitfield.
	const ycbcr709 = 1 << 2
	const nominal16to235 = 1 << 4
	inCS, outCS := uint32(0), uint32(ycbcr709|nominal16to235)
	c.vctx.call(videoContextSetInColorSpace, uintptr(c.vp), 0, uintptr(unsafe.Pointer(&inCS)))
	c.vctx.call(videoContextSetOutColorSpace, uintptr(c.vp), uintptr(unsafe.Pointer(&outCS)))
	c.vctx.call(videoContextSetFrameFormat, uintptr(c.vp), 0, 0)
	c.vctx.call(videoContextSetAutoProcess, uintptr(c.vp), 0, 0)
	full := rect{0, 0, int32(w), int32(h)}
	c.vctx.call(videoContextSetOutputRect, uintptr(c.vp), 1, uintptr(unsafe.Pointer(&full)))
	c.vctx.call(videoContextSetDestRect, uintptr(c.vp), 0, 1, uintptr(unsafe.Pointer(&full)))
	return c, nil
}

// convert renders crop of the source into the next NV12 texture.
func (c *converter) convert(crop rect) (iface, error) {
	t := c.outs[c.next]
	c.next = (c.next + 1) % len(c.outs)
	c.vctx.call(videoContextSetSourceRect, uintptr(c.vp), 0, 1, uintptr(unsafe.Pointer(&crop)))
	s := vpStream{Enable: 1, InputSurface: uintptr(c.in)}
	if err := c.vctx.hcall("VideoProcessorBlt", videoContextBlt, uintptr(c.vp), uintptr(t.view), 0, 1, uintptr(unsafe.Pointer(&s))); err != nil {
		return 0, err
	}
	return t.tex, nil
}

func (c *converter) close() {
	for _, t := range c.outs {
		t.view.release()
		t.tex.release()
	}
	c.in.release()
	c.vp.release()
	c.enum.release()
	c.vctx.release()
	c.vdev.release()
}

// readNV12 copies an NV12 texture to memory, for an encoder that can't take
// GPU textures: w×h luma rows, then w×h/2 bytes of interleaved chroma.
func (g *gpu) readNV12(staging, tex iface, w, h int, dst []byte) error {
	g.context.call(contextCopyResource, uintptr(staging), uintptr(tex))
	var m mappedSubresource
	if err := g.context.hcall("Map", contextMap, uintptr(staging), 0, mapRead, 0, uintptr(unsafe.Pointer(&m))); err != nil {
		return err
	}
	defer g.context.call(contextUnmap, uintptr(staging), 0)
	if m.Data == 0 {
		return errors.New("mapping the frame failed")
	}
	pitch := int(m.RowPitch)
	src := unsafe.Slice((*byte)(sysPointer(m.Data)), pitch*h*3/2)
	for y := range h {
		copy(dst[y*w:(y+1)*w], src[y*pitch:])
	}
	uv := src[pitch*h:]
	for y := range h / 2 {
		copy(dst[w*h+y*w:w*h+(y+1)*w], uv[y*pitch:])
	}
	return nil
}
