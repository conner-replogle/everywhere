package capture

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	iidIMFTransform          = guid(0xbf94c121, 0x5b05, 0x4e6f, 0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d)
	iidIMFMediaEventGenerate = guid(0x2cd0bd52, 0xbcd5, 0x4b89, 0xb6, 0x2c, 0xea, 0xdc, 0x0c, 0x03, 0x1e, 0x7d)
	iidIMF2DBuffer           = guid(0x7dc9d5f9, 0x9ed9, 0x44ec, 0x9b, 0xbf, 0x06, 0x00, 0xbb, 0x58, 0x9f, 0xbb)
	iidICodecAPI             = guid(0x901db4c7, 0x31ce, 0x41a2, 0x85, 0xdc, 0x8f, 0xa0, 0xbf, 0x41, 0xb8, 0xda)

	mfMediaTypeVideo   = guid(0x73646976, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71)
	mfVideoFormatNV12  = guid(0x3231564e, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71)
	mfVideoFormatH264  = guid(0x34363248, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71)
	mftCategoryEncoder = guid(0xf79eac7d, 0xe545, 0x4387, 0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a)

	mfMTMajorType       = guid(0x48eba18e, 0xf8c9, 0x4687, 0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f)
	mfMTSubtype         = guid(0xf7e34c9a, 0x42e8, 0x4714, 0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5)
	mfMTFrameSize       = guid(0x1652c33d, 0xd6b2, 0x4012, 0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d)
	mfMTFrameRate       = guid(0xc459a2e8, 0x3d2c, 0x4e44, 0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0)
	mfMTAvgBitrate      = guid(0x20332624, 0xfb0d, 0x4d9e, 0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e)
	mfMTInterlaceMode   = guid(0xe2724bb8, 0xe676, 0x4806, 0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd)
	mfMTPixelAspect     = guid(0xc6376a1e, 0x8d0a, 0x4027, 0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6)
	mfMTMpeg2Profile    = guid(0xad76a80b, 0x2d5c, 0x4e0b, 0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36)
	mfMTSequenceHeader  = guid(0x3c036de7, 0x3ad0, 0x4c9e, 0x92, 0x16, 0xee, 0x6d, 0x6a, 0xc2, 0x1c, 0xb3)
	mfMTYUVMatrix       = guid(0x3e23d450, 0x2c75, 0x4d25, 0xa0, 0x0e, 0xb9, 0x16, 0x70, 0xd1, 0x23, 0x27)
	mfMTNominalRange    = guid(0xc21b8ee5, 0xb956, 0x4071, 0x8d, 0xaf, 0x32, 0x5e, 0xdf, 0x5c, 0xab, 0x11)
	mfTransformAsync    = guid(0xf81a699a, 0x649a, 0x497d, 0x8c, 0x73, 0x29, 0xf8, 0xfe, 0xd6, 0xad, 0x7a)
	mfTransformUnlock   = guid(0xe5666d6b, 0x3422, 0x4eb6, 0xa4, 0x21, 0xda, 0x7d, 0xb1, 0xf8, 0xe2, 0x07)
	mfSAD3D11Aware      = guid(0x206b4fc8, 0xfcf9, 0x4c51, 0xaf, 0xe3, 0x97, 0x64, 0x36, 0x9e, 0x33, 0xa0)
	mfLowLatency        = guid(0x9c27891a, 0xed7a, 0x40e1, 0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee)
	mfSampleCleanPoint  = guid(0x9cdf01d8, 0xa0f0, 0x43ba, 0xb0, 0x77, 0xea, 0xa0, 0x6c, 0xbd, 0x72, 0x8a)
	mftFriendlyName     = guid(0x314ffbae, 0x5b41, 0x4c95, 0x9c, 0x19, 0x4e, 0x7d, 0x58, 0x6f, 0xac, 0xe3)
	codecLowLatencyMode = guid(0x9c27891a, 0xed7a, 0x40e1, 0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee)
	codecRateControl    = guid(0x1c0608e9, 0x370c, 0x4710, 0x8a, 0x58, 0xcb, 0x61, 0x81, 0xc4, 0x24, 0x23)
	codecMeanBitRate    = guid(0xf7222374, 0x2144, 0x4815, 0xb5, 0x50, 0xa3, 0x7f, 0x8e, 0x12, 0xee, 0x52)
	codecQualityVsSpeed = guid(0x98332df8, 0x03cd, 0x476b, 0x89, 0xfa, 0x3f, 0x9e, 0x44, 0x2d, 0xec, 0x9f)
	codecGOPSize        = guid(0x95f31b26, 0x95a4, 0x41aa, 0x93, 0x03, 0x24, 0x6a, 0x7f, 0xc6, 0xee, 0xf1)
	codecBPictures      = guid(0x8d390aac, 0xdc5c, 0x4200, 0xb5, 0x7f, 0x81, 0x4d, 0x04, 0xba, 0xba, 0xb2)
	codecForceKeyFrame  = guid(0x398c1b98, 0x8353, 0x475a, 0x9e, 0xf2, 0x8f, 0x26, 0x5d, 0x26, 0x03, 0x45)
)

// Vtable indices (Windows SDK headers).
const (
	attrGetUINT32     = 7
	attrGetBlobSize   = 14
	attrGetBlob       = 15
	attrGetString     = 12
	attrGetStringLen  = 11
	attrSetUINT32     = 21
	attrSetUINT64     = 22
	attrSetGUID       = 24
	activateActivate  = 33
	activateShutdown  = 34
	eventGetType      = 33
	sampleGetTime     = 35
	sampleSetTime     = 36
	sampleSetDuration = 38
	sampleAddBuffer   = 42
	sampleToBuffer    = 41
	bufferLock        = 3
	bufferUnlock      = 4
	bufferSetLength   = 6
	buffer2DContigLen = 7

	mftGetOutputStreamInfo = 7
	mftGetAttributes       = 8
	mftSetInputType        = 15
	mftSetOutputType       = 16
	mftGetOutputCurrent    = 18
	mftProcessMessage      = 23
	mftProcessInput        = 24
	mftProcessOutput       = 25

	eventGenGetEvent = 3

	codecSetValue = 9

	devManagerReset = 7
)

const (
	mfVersion = 0x00020070

	mftEnumHardware      = 0x04
	mftEnumSyncMFT       = 0x01
	mftEnumSortAndFilter = 0x40

	msgSetD3DManager     = 0x2
	msgBeginStreaming    = 0x10000000
	msgStartOfStream     = 0x10000003
	msgEndOfStream       = 0x10000002
	msgCommandFlush      = 0x0
	providesSamples      = 0x100
	canProvideSamples    = 0x200
	eventNeedInput       = 601
	eventHaveOutput      = 602
	eventFlagNoWait      = 1
	interlaceProgressive = 2
	profileH264High      = 100
	profileH264Main      = 77
	rateControlCBR       = 0
	matrixBT709          = 1
	nominalRange16to235  = 2
	frameRateForEncoder  = 60
)

type encodedFrame struct {
	data     []byte
	keyframe bool
	at       int64 // the input sample's time, 100ns
}

// encoder is a Media Foundation H.264 encoder MFT.
type encoder struct {
	name     string
	activate iface
	mft      iface
	codec    iface // ICodecAPI, if it has one
	events   iface // IMFMediaEventGenerator for an async (hardware) MFT
	manager  iface // IMFDXGIDeviceManager, when it takes textures
	d3d      bool  // takes D3D11 textures rather than memory
	provides bool  // allocates its own output samples
	outSize  int
	w, h     int

	needInput int // async: inputs it asked for
	seqHeader []byte

	// For an encoder that takes memory: a staging copy of each frame.
	g       *gpu
	staging iface
	nv12    []byte
}

type registerTypeInfo struct {
	Major, Sub windows.GUID
}

// newEncoder starts the first H.264 encoder that works with g: a hardware
// one on its adapter if there is one, else Microsoft's software encoder.
func newEncoder(g *gpu, w, h, kbps, quality int) (*encoder, error) {
	var errs []error
	for _, flags := range []uint32{mftEnumHardware | mftEnumSortAndFilter, mftEnumSyncMFT | mftEnumSortAndFilter} {
		in := registerTypeInfo{mfMediaTypeVideo, mfVideoFormatNV12}
		out := registerTypeInfo{mfMediaTypeVideo, mfVideoFormatH264}
		var list uintptr
		var count uint32
		// The pointers are converted in the calls, so they stay put (see call).
		var err error
		if cat := guidByValue(&mftCategoryEncoder); len(cat) == 2 {
			err = callProc(procMFTEnumEx, cat[0], cat[1], uintptr(flags),
				uintptr(unsafe.Pointer(&in)), uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&count)))
		} else {
			err = callProc(procMFTEnumEx, cat[0], uintptr(flags),
				uintptr(unsafe.Pointer(&in)), uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&count)))
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		activates := unsafe.Slice((*iface)(sysPointer(list)), count)
		var found *encoder
		for i, a := range activates {
			if found == nil {
				e, err := startEncoder(a, g, w, h, kbps, quality)
				if err == nil {
					found = e
					continue // keeps a's reference
				}
				errs = append(errs, err)
			}
			activates[i].release()
		}
		windows.CoTaskMemFree(sysPointer(list))
		if found != nil {
			return found, nil
		}
	}
	if len(errs) == 0 {
		return nil, errors.New("this computer has no H.264 encoder")
	}
	return nil, fmt.Errorf("no H.264 encoder would start: %w", errors.Join(errs...))
}

func attrString(a iface, key *windows.GUID) string {
	var n uint32
	if a.call(attrGetStringLen, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&n))) != 0 || n == 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	if a.call(attrGetString, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&buf[0])), uintptr(n+1), 0) != 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}

func attrUINT32(a iface, key *windows.GUID) (uint32, bool) {
	var v uint32
	return v, a.call(attrGetUINT32, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&v))) == 0
}

func startEncoder(a iface, g *gpu, w, h, kbps, quality int) (*encoder, error) {
	e := &encoder{name: attrString(a, &mftFriendlyName), activate: a, w: w, h: h, g: g}
	if err := a.hcall("ActivateObject", activateActivate, uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&e.mft))); err != nil {
		return nil, fmt.Errorf("%s: %w", e.name, err)
	}
	if err := e.configure(kbps, quality); err != nil {
		e.close()
		return nil, fmt.Errorf("%s: %w", e.name, err)
	}
	slog.Info("desktop encoder", "name", e.name, "gpu", e.d3d, "async", e.events != 0, "size", [2]int{w, h})
	return e, nil
}

func (e *encoder) configure(kbps, quality int) error {
	var attrs iface
	if err := e.mft.hcall("GetAttributes", mftGetAttributes, uintptr(unsafe.Pointer(&attrs))); err == nil {
		if v, ok := attrUINT32(attrs, &mfTransformAsync); ok && v != 0 {
			attrs.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfTransformUnlock)), 1)
			ev, err := e.mft.queryInterface(&iidIMFMediaEventGenerate)
			if err != nil {
				attrs.release()
				return err
			}
			e.events = ev
		}
		if v, ok := attrUINT32(attrs, &mfSAD3D11Aware); ok && v != 0 {
			e.d3d = true
		}
		attrs.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfLowLatency)), 1)
		attrs.release()
	}
	if e.d3d {
		var token uint32
		if err := callProc(procMFCreateDXGIDeviceManager, uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&e.manager))); err != nil {
			return err
		}
		if err := e.manager.hcall("ResetDevice", devManagerReset, uintptr(e.g.device), uintptr(token)); err != nil {
			return err
		}
		// An encoder on another GPU refuses the device.
		if err := e.mft.hcall("SET_D3D_MANAGER", mftProcessMessage, msgSetD3DManager, uintptr(e.manager)); err != nil {
			return err
		}
	}
	if c, err := e.mft.queryInterface(&iidICodecAPI); err == nil {
		e.codec = c
		e.setCodec(&codecLowLatencyMode, variantBool(true))
		e.setCodec(&codecRateControl, variantUI4(rateControlCBR))
		e.setCodec(&codecMeanBitRate, variantUI4(uint32(kbps*1000)))
		e.setCodec(&codecQualityVsSpeed, variantUI4(uint32(quality)))
		e.setCodec(&codecBPictures, variantUI4(0))
		e.setCodec(&codecGOPSize, variantUI4(1024))
	}

	var err error
	for _, profile := range []uint32{profileH264High, profileH264Main} {
		if err = e.setOutputType(kbps, profile); err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	in, err := e.mediaType(mfVideoFormatNV12)
	if err != nil {
		return err
	}
	in.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTYUVMatrix)), matrixBT709)
	in.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTNominalRange)), nominalRange16to235)
	err = e.mft.hcall("SetInputType", mftSetInputType, 0, uintptr(in), 0)
	in.release()
	if err != nil {
		return err
	}

	var info struct{ Flags, Size, Alignment uint32 }
	if err := e.mft.hcall("GetOutputStreamInfo", mftGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&info))); err != nil {
		return err
	}
	e.provides = info.Flags&(providesSamples|canProvideSamples) != 0
	e.outSize = int(info.Size)
	if e.outSize == 0 {
		e.outSize = e.w * e.h * 3 / 2
	}
	if !e.d3d {
		if e.staging, err = e.g.stagingTexture(e.w, e.h, formatNV12); err != nil {
			return err
		}
		e.nv12 = make([]byte, e.w*e.h*3/2)
	}
	e.mft.call(mftProcessMessage, msgBeginStreaming, 0)
	e.mft.call(mftProcessMessage, msgStartOfStream, 0)
	if e.events == 0 {
		e.needInput = 1 // a synchronous MFT always takes input
	}
	return nil
}

func (e *encoder) mediaType(sub windows.GUID) (iface, error) {
	var t iface
	if err := callProc(procMFCreateMediaType, uintptr(unsafe.Pointer(&t))); err != nil {
		return 0, err
	}
	t.call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTMajorType)), uintptr(unsafe.Pointer(&mfMediaTypeVideo)))
	t.call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTSubtype)), uintptr(unsafe.Pointer(&sub)))
	t.call(attrSetUINT64, uintptr(unsafe.Pointer(&mfMTFrameSize)), uintptr(uint64(e.w)<<32|uint64(e.h)))
	t.call(attrSetUINT64, uintptr(unsafe.Pointer(&mfMTFrameRate)), uintptr(uint64(frameRateForEncoder)<<32|1))
	t.call(attrSetUINT64, uintptr(unsafe.Pointer(&mfMTPixelAspect)), uintptr(uint64(1)<<32|1))
	t.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTInterlaceMode)), interlaceProgressive)
	return t, nil
}

func (e *encoder) setOutputType(kbps int, profile uint32) error {
	t, err := e.mediaType(mfVideoFormatH264)
	if err != nil {
		return err
	}
	defer t.release()
	t.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTAvgBitrate)), uintptr(kbps*1000))
	t.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTMpeg2Profile)), uintptr(profile))
	t.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTYUVMatrix)), matrixBT709)
	t.call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTNominalRange)), nominalRange16to235)
	return e.mft.hcall("SetOutputType", mftSetOutputType, 0, uintptr(t), 0)
}

func (e *encoder) setCodec(api *windows.GUID, v *variant) {
	if e.codec != 0 {
		e.codec.call(codecSetValue, uintptr(unsafe.Pointer(api)), uintptr(unsafe.Pointer(v)))
	}
}

func (e *encoder) setBitrate(kbps int) {
	e.setCodec(&codecMeanBitRate, variantUI4(uint32(kbps*1000)))
}

// forceKeyframe makes the next frame a keyframe.
func (e *encoder) forceKeyframe() {
	e.setCodec(&codecForceKeyFrame, variantUI4(1))
}

// pump handles an async MFT's events: requests for input, and output that's
// ready. Output goes to emit.
func (e *encoder) pump(emit func(encodedFrame)) error {
	if e.events == 0 {
		return nil
	}
	for {
		var ev iface
		err := e.events.hcall("GetEvent", eventGenGetEvent, eventFlagNoWait, uintptr(unsafe.Pointer(&ev)))
		if is(err, mfErrorNoEventsAvailable) {
			return nil
		}
		if err != nil {
			return err
		}
		var typ uint32
		ev.call(eventGetType, uintptr(unsafe.Pointer(&typ)))
		ev.release()
		switch typ {
		case eventNeedInput:
			e.needInput++
		case eventHaveOutput:
			if err := e.output(emit); err != nil && !is(err, mfErrorNeedMoreInput) {
				return err
			}
		}
	}
}

// ready reports whether the encoder will take a frame now.
func (e *encoder) ready() bool { return e.needInput > 0 }

// encode feeds one NV12 texture, timestamped at (100ns units).
func (e *encoder) encode(tex iface, at int64, emit func(encodedFrame)) error {
	var buf iface
	if e.d3d {
		if err := callProc(procMFCreateDXGISurfaceBuffer, uintptr(unsafe.Pointer(&iidID3D11Texture2D)), uintptr(tex), 0, 0, uintptr(unsafe.Pointer(&buf))); err != nil {
			return err
		}
		if b2, err := buf.queryInterface(&iidIMF2DBuffer); err == nil {
			var n uint32
			b2.call(buffer2DContigLen, uintptr(unsafe.Pointer(&n)))
			buf.call(bufferSetLength, uintptr(n))
			b2.release()
		}
	} else {
		if err := e.g.readNV12(e.staging, tex, e.w, e.h, e.nv12); err != nil {
			return err
		}
		var err error
		if buf, err = memoryBuffer(e.nv12); err != nil {
			return err
		}
	}
	defer buf.release()
	var sample iface
	if err := callProc(procMFCreateSample, uintptr(unsafe.Pointer(&sample))); err != nil {
		return err
	}
	defer sample.release()
	sample.call(sampleAddBuffer, uintptr(buf))
	sample.call(sampleSetTime, uintptr(at))
	sample.call(sampleSetDuration, uintptr(10_000_000/frameRateForEncoder))
	if err := e.mft.hcall("ProcessInput", mftProcessInput, 0, uintptr(sample), 0); err != nil {
		if is(err, mfErrorNotAccepting) {
			e.needInput = 0
			return nil // dropped; it'll ask again
		}
		return err
	}
	if e.events != 0 {
		e.needInput--
		return nil
	}
	// Synchronous: collect whatever's ready.
	for {
		err := e.output(emit)
		if is(err, mfErrorNeedMoreInput) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func memoryBuffer(data []byte) (iface, error) {
	var buf iface
	if err := callProc(procMFCreateMemoryBuffer, uintptr(len(data)), uintptr(unsafe.Pointer(&buf))); err != nil {
		return 0, err
	}
	var p uintptr
	if err := buf.hcall("Lock", bufferLock, uintptr(unsafe.Pointer(&p)), 0, 0); err != nil {
		buf.release()
		return 0, err
	}
	copy(unsafe.Slice((*byte)(sysPointer(p)), len(data)), data)
	buf.call(bufferUnlock)
	buf.call(bufferSetLength, uintptr(len(data)))
	return buf, nil
}

type outputDataBuffer struct {
	StreamID uint32
	Sample   iface
	Status   uint32
	Events   iface
}

// output takes one encoded frame from the MFT.
func (e *encoder) output(emit func(encodedFrame)) error {
	ob := outputDataBuffer{}
	if !e.provides {
		var err error
		if ob.Sample, err = e.outputSample(); err != nil {
			return err
		}
	}
	var status uint32
	err := e.mft.hcall("ProcessOutput", mftProcessOutput, 0, 1, uintptr(unsafe.Pointer(&ob)), uintptr(unsafe.Pointer(&status)))
	defer ob.Sample.release()
	defer ob.Events.release()
	if is(err, mfErrorStreamChange) {
		return e.renegotiate()
	}
	if err != nil {
		return err
	}
	if ob.Sample == 0 {
		return nil
	}
	data, err := sampleBytes(ob.Sample)
	if err != nil {
		return err
	}
	key, _ := attrUINT32(ob.Sample, &mfSampleCleanPoint)
	f := encodedFrame{data: data, keyframe: key != 0}
	ob.Sample.call(sampleGetTime, uintptr(unsafe.Pointer(&f.at)))
	if f.keyframe && !hasNAL(data, 7) {
		// Some encoders keep SPS and PPS in the media type only.
		if e.seqHeader == nil {
			e.seqHeader = e.sequenceHeader()
		}
		f.data = append(append([]byte(nil), e.seqHeader...), data...)
	}
	emit(f)
	return nil
}

func (e *encoder) outputSample() (iface, error) {
	var sample iface
	if err := callProc(procMFCreateSample, uintptr(unsafe.Pointer(&sample))); err != nil {
		return 0, err
	}
	var buf iface
	if err := callProc(procMFCreateMemoryBuffer, uintptr(e.outSize), uintptr(unsafe.Pointer(&buf))); err != nil {
		sample.release()
		return 0, err
	}
	sample.call(sampleAddBuffer, uintptr(buf))
	buf.release()
	return sample, nil
}

func (e *encoder) renegotiate() error {
	e.seqHeader = nil
	var t iface
	if err := e.mft.hcall("GetOutputCurrentType", mftGetOutputCurrent, 0, uintptr(unsafe.Pointer(&t))); err != nil {
		return err
	}
	defer t.release()
	return e.mft.hcall("SetOutputType", mftSetOutputType, 0, uintptr(t), 0)
}

func (e *encoder) sequenceHeader() []byte {
	var t iface
	if e.mft.call(mftGetOutputCurrent, 0, uintptr(unsafe.Pointer(&t))) != 0 {
		return []byte{}
	}
	defer t.release()
	var n uint32
	if t.call(attrGetBlobSize, uintptr(unsafe.Pointer(&mfMTSequenceHeader)), uintptr(unsafe.Pointer(&n))) != 0 || n == 0 {
		return []byte{}
	}
	b := make([]byte, n)
	if t.call(attrGetBlob, uintptr(unsafe.Pointer(&mfMTSequenceHeader)), uintptr(unsafe.Pointer(&b[0])), uintptr(n), 0) != 0 {
		return []byte{}
	}
	return b
}

func sampleBytes(sample iface) ([]byte, error) {
	var buf iface
	if err := sample.hcall("ConvertToContiguousBuffer", sampleToBuffer, uintptr(unsafe.Pointer(&buf))); err != nil {
		return nil, err
	}
	defer buf.release()
	var p uintptr
	var n uint32
	if err := buf.hcall("Lock", bufferLock, uintptr(unsafe.Pointer(&p)), 0, uintptr(unsafe.Pointer(&n))); err != nil {
		return nil, err
	}
	defer buf.call(bufferUnlock)
	return bytes.Clone(unsafe.Slice((*byte)(sysPointer(p)), n)), nil
}

// hasNAL reports whether an Annex-B access unit contains a NAL unit of typ.
func hasNAL(au []byte, typ byte) bool {
	for i := 0; i+3 < len(au); i++ {
		if au[i] == 0 && au[i+1] == 0 && au[i+2] == 1 && au[i+3]&0x1f == typ {
			return true
		}
	}
	return false
}

func (e *encoder) close() {
	if e.mft != 0 {
		e.mft.call(mftProcessMessage, msgCommandFlush, 0)
	}
	e.staging.release()
	e.codec.release()
	e.events.release()
	e.mft.release()
	if e.activate != 0 {
		e.activate.call(activateShutdown)
		e.activate.release()
	}
	e.manager.release()
}
