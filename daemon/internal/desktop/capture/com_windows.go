package capture

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Minimal COM plumbing: an interface pointer is called through its vtable by
// method index. The indices come from the Windows SDK headers' Vtbl structs
// (IUnknown's three methods first).

type iface uintptr

// sysPointer turns an address of memory COM owns into a pointer, without
// vet mistaking it for a Go pointer that escaped the garbage collector.
func sysPointer(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

// The methods taking args as uintptrs are marked uintptrescapes, as
// syscall's are: a pointer converted to uintptr in the call is then kept
// alive, and off the stack (which can move), until the call returns.

//go:uintptrescapes
func (i iface) call(method int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(sysPointer(uintptr(i)))
	fn := *(*uintptr)(sysPointer(vtbl + uintptr(method)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(i)}, args...)...)
	return r
}

// hcall calls a method returning an HRESULT.
//
//go:uintptrescapes
func (i iface) hcall(name string, method int, args ...uintptr) error {
	return check(name, i.call(method, args...))
}

func (i iface) queryInterface(iid *windows.GUID) (iface, error) {
	var out iface
	err := i.hcall("QueryInterface", 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	return out, err
}

func (i iface) release() {
	if i != 0 {
		i.call(2)
	}
}

// hresult is a failed HRESULT.
type hresult struct {
	op   string
	code uint32
}

func (e hresult) Error() string { return fmt.Sprintf("%s: HRESULT 0x%08X", e.op, e.code) }

func check(op string, r uintptr) error {
	if int32(r) < 0 {
		return hresult{op, uint32(r)}
	}
	return nil
}

// is reports whether err is the HRESULT code.
func is(err error, code uint32) bool {
	h, ok := err.(hresult)
	return ok && h.code == code
}

// HRESULTs this package handles.
const (
	dxgiErrorNotFound          = 0x887A0002
	dxgiErrorAccessLost        = 0x887A0026
	dxgiErrorWaitTimeout       = 0x887A0027
	mfErrorNoEventsAvailable   = 0xC00D3E80
	mfErrorNeedMoreInput       = 0xC00D6D72
	mfErrorStreamChange        = 0xC00D6D61
	mfErrorNotAccepting        = 0xC00D36B5
	eAccessDenied              = 0x80070005
	dxgiErrorSessionDisconnect = 0x887A0028
)

func guid(d1 uint32, d2, d3 uint16, d4 ...byte) windows.GUID {
	g := windows.GUID{Data1: d1, Data2: d2, Data3: d3}
	copy(g.Data4[:], d4)
	return g
}

// variant is a VARIANT holding a 32-bit unsigned value or a boolean; 24
// bytes on 64-bit Windows, the value at offset 8.
type variant struct {
	vt  uint16
	_   [3]uint16
	val uint64
	_   uint64
}

const (
	vtBool = 11
	vtUI4  = 19
)

func variantUI4(v uint32) *variant { return &variant{vt: vtUI4, val: uint64(v)} }
func variantBool(b bool) *variant {
	if b {
		return &variant{vt: vtBool, val: 0xffff} // VARIANT_TRUE
	}
	return &variant{vt: vtBool}
}

var (
	modD3D11  = windows.NewLazySystemDLL("d3d11.dll")
	modDXGI   = windows.NewLazySystemDLL("dxgi.dll")
	modMFPlat = windows.NewLazySystemDLL("mfplat.dll")

	procD3D11CreateDevice         = modD3D11.NewProc("D3D11CreateDevice")
	procCreateDXGIFactory1        = modDXGI.NewProc("CreateDXGIFactory1")
	procMFStartup                 = modMFPlat.NewProc("MFStartup")
	procMFShutdown                = modMFPlat.NewProc("MFShutdown")
	procMFTEnumEx                 = modMFPlat.NewProc("MFTEnumEx")
	procMFCreateMediaType         = modMFPlat.NewProc("MFCreateMediaType")
	procMFCreateSample            = modMFPlat.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer      = modMFPlat.NewProc("MFCreateMemoryBuffer")
	procMFCreateDXGISurfaceBuffer = modMFPlat.NewProc("MFCreateDXGISurfaceBuffer")
	procMFCreateDXGIDeviceManager = modMFPlat.NewProc("MFCreateDXGIDeviceManager")
)

// guidByValue passes a GUID argument taken by value: x64 passes a 16-byte
// struct as a pointer to it (the callee doesn't change it), ARM64 in two
// registers. g must stay reachable until the call returns: a package global.
func guidByValue(g *windows.GUID) []uintptr {
	if runtime.GOARCH == "arm64" {
		w := (*[2]uint64)(unsafe.Pointer(g))
		return []uintptr{uintptr(w[0]), uintptr(w[1])}
	}
	return []uintptr{uintptr(unsafe.Pointer(g))}
}

//go:uintptrescapes
func callProc(p *windows.LazyProc, args ...uintptr) error {
	if err := p.Find(); err != nil {
		return err
	}
	r, _, _ := p.Call(args...)
	return check(p.Name, r)
}
