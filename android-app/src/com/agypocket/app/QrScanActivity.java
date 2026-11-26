package com.agypocket.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public class QrScanActivity extends Activity {

    public static final String EXTRA_HINT = "scan_hint";
    public static final String EXTRA_QR_TEXT = "qr_text";
    public static final String EXTRA_ACTION = "scan_action";
    public static final String ACTION_MANUAL = "manual";

    private static final int REQ_CAMERA_PERM = 2001;

    private FrameLayout rootLayout;
    private TextureView textureView;
    private LinearLayout permissionFallbackLayout;
    private Button torchBtn;

    private HandlerThread bgThread;
    private Handler bgHandler;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private CaptureRequest.Builder previewRequestBuilder;
    private ImageReader imageReader;
    private String cameraId;
    private Size previewSize = new Size(1280, 720);
    private int sensorOrientation = 90;
    private boolean hasFlash = false;
    private boolean torchOn = false;

    private final QRCodeReader qrReader = new QRCodeReader();
    private final Map<DecodeHintType, Object> decodeHints = new EnumMap<>(DecodeHintType.class);
    private final AtomicBoolean scanDone = new AtomicBoolean(false);
    private long lastDecodeAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(0xFF090B10);
        window.setNavigationBarColor(0xFF090B10);

        decodeHints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        decodeHints.put(DecodeHintType.CHARACTER_SET, "UTF-8");

        buildUi();
        checkPermissionAndStart();
    }

    private void buildUi() {
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(0xFF090B10);

        textureView = new TextureView(this);
        rootLayout.addView(textureView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        ViewfinderOverlayView overlay = new ViewfinderOverlayView(this);
        rootLayout.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        float density = getResources().getDisplayMetrics().density;
        int pad = (int) (16 * density);

        // Top hint banner
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.VERTICAL);
        topBar.setPadding(pad, (int) (36 * density), pad, pad);

        TextView titleTv = new TextView(this);
        titleTv.setText("扫描电脑端 AgyPocket 二维码");
        titleTv.setTextColor(0xFFEEF2FF);
        titleTv.setTextSize(17f);
        titleTv.setGravity(Gravity.CENTER);
        topBar.addView(titleTv);

        String hint = getIntent().getStringExtra(EXTRA_HINT);
        if (hint == null || hint.trim().isEmpty()) {
            hint = "请对准电脑启动器屏幕上的二维码（自动识别固定/临时模式并信任证书）";
        }
        TextView hintTv = new TextView(this);
        hintTv.setText(hint);
        hintTv.setTextColor(0xFFCBD5E1);
        hintTv.setTextSize(12.5f);
        hintTv.setGravity(Gravity.CENTER);
        hintTv.setPadding(0, (int) (6 * density), 0, 0);
        topBar.addView(hintTv);

        FrameLayout.LayoutParams topLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP);
        rootLayout.addView(topBar, topLp);

        // Bottom controls
        LinearLayout bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.VERTICAL);
        bottomBar.setGravity(Gravity.CENTER_HORIZONTAL);
        bottomBar.setPadding(pad, pad, pad, (int) (28 * density));

        torchBtn = new Button(this);
        torchBtn.setText("手电筒: 关");
        torchBtn.setOnClickListener(v -> toggleTorch());
        bottomBar.addView(torchBtn);

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setGravity(Gravity.CENTER);
        actionRow.setPadding(0, (int) (8 * density), 0, 0);

        Button manualBtn = new Button(this);
        manualBtn.setText("手动输入网址");
        manualBtn.setOnClickListener(v -> finishWithManual());
        actionRow.addView(manualBtn);

        Button manualDocBtn = new Button(this);
        manualDocBtn.setText("使用说明书");
        manualDocBtn.setOnClickListener(v -> MainActivity.showUserManualDialog(this));
        actionRow.addView(manualDocBtn);

        Button cancelBtn = new Button(this);
        cancelBtn.setText("返回");
        cancelBtn.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        actionRow.addView(cancelBtn);

        bottomBar.addView(actionRow);

        FrameLayout.LayoutParams bottomLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM);
        rootLayout.addView(bottomBar, bottomLp);

        // Permission denied view
        permissionFallbackLayout = new LinearLayout(this);
        permissionFallbackLayout.setOrientation(LinearLayout.VERTICAL);
        permissionFallbackLayout.setGravity(Gravity.CENTER);
        permissionFallbackLayout.setBackgroundColor(0xEE090B10);
        permissionFallbackLayout.setPadding(pad * 2, pad * 2, pad * 2, pad * 2);
        permissionFallbackLayout.setVisibility(View.GONE);

        TextView permMsg = new TextView(this);
        permMsg.setText("需要相机权限以扫描电脑端配对二维码。\n你也可以选择“前往系统设置授权”或“改用手动输入”。");
        permMsg.setTextColor(0xFFEEF2FF);
        permMsg.setTextSize(14f);
        permMsg.setGravity(Gravity.CENTER);
        permMsg.setPadding(0, 0, 0, pad);
        permissionFallbackLayout.addView(permMsg);

        Button settingsBtn = new Button(this);
        settingsBtn.setText("前往系统设置授权");
        settingsBtn.setOnClickListener(v -> {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getPackageName(), null));
            startActivity(intent);
        });
        permissionFallbackLayout.addView(settingsBtn);

        Button fallbackManualBtn = new Button(this);
        fallbackManualBtn.setText("改用手动输入");
        fallbackManualBtn.setOnClickListener(v -> finishWithManual());
        permissionFallbackLayout.addView(fallbackManualBtn);

        rootLayout.addView(permissionFallbackLayout, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(rootLayout);
    }

    private void finishWithManual() {
        Intent res = new Intent();
        res.putExtra(EXTRA_ACTION, ACTION_MANUAL);
        setResult(RESULT_CANCELED, res);
        finish();
    }

    private void checkPermissionAndStart() {
        if (Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
        } else {
            permissionFallbackLayout.setVisibility(View.GONE);
            startTextureWhenReady();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERM) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                permissionFallbackLayout.setVisibility(View.GONE);
                startTextureWhenReady();
            } else {
                permissionFallbackLayout.setVisibility(View.VISIBLE);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        startBgThread();
        if (Build.VERSION.SDK_INT < 23 ||
                checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            permissionFallbackLayout.setVisibility(View.GONE);
            startTextureWhenReady();
        }
    }

    @Override
    protected void onPause() {
        closeCamera();
        stopBgThread();
        super.onPause();
    }

    private void startBgThread() {
        if (bgThread == null) {
            bgThread = new HandlerThread("agypocket-qr-cam");
            bgThread.start();
            bgHandler = new Handler(bgThread.getLooper());
        }
    }

    private void stopBgThread() {
        if (bgThread != null) {
            bgThread.quitSafely();
            try {
                bgThread.join(1000);
            } catch (InterruptedException ignored) {
            }
            bgThread = null;
            bgHandler = null;
        }
    }

    private void startTextureWhenReady() {
        if (textureView.isAvailable()) {
            openCamera(textureView.getWidth(), textureView.getHeight());
        } else {
            textureView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                @Override
                public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                    openCamera(width, height);
                }

                @Override
                public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
                    configureTransform(width, height);
                }

                @Override
                public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
                    return true;
                }

                @Override
                public void onSurfaceTextureUpdated(SurfaceTexture surface) {
                }
            });
        }
    }

    @SuppressWarnings("MissingPermission")
    private void openCamera(int viewWidth, int viewHeight) {
        if (cameraDevice != null) return;
        CameraManager mgr = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        if (mgr == null) return;
        try {
            String chosenId = null;
            for (String id : mgr.getCameraIdList()) {
                CameraCharacteristics cc = mgr.getCameraCharacteristics(id);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    chosenId = id;
                    break;
                }
            }
            if (chosenId == null && mgr.getCameraIdList().length > 0) {
                chosenId = mgr.getCameraIdList()[0];
            }
            if (chosenId == null) {
                Toast.makeText(this, "未找到可用摄像头", Toast.LENGTH_SHORT).show();
                return;
            }
            cameraId = chosenId;
            CameraCharacteristics cc = mgr.getCameraCharacteristics(chosenId);
            Integer orient = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = orient != null ? orient : 90;
            Boolean flashAvail = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            hasFlash = flashAvail != null && flashAvail;
            mainHandler.post(() -> torchBtn.setVisibility(hasFlash ? View.VISIBLE : View.GONE));

            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map != null) {
                Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
                previewSize = chooseOptimalSize(sizes);
            }

            configureTransform(viewWidth, viewHeight);
            imageReader = ImageReader.newInstance(
                    previewSize.getWidth(),
                    previewSize.getHeight(),
                    ImageFormat.YUV_420_888,
                    2);
            imageReader.setOnImageAvailableListener(this::onImageAvailable, bgHandler);

            mgr.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    cameraDevice = camera;
                    createPreviewSession();
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    cameraDevice = null;
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
                    cameraDevice = null;
                }
            }, bgHandler);
        } catch (CameraAccessException | SecurityException e) {
            mainHandler.post(() -> Toast.makeText(this, "相机启动失败: " + e.getMessage(), Toast.LENGTH_SHORT).show());
        }
    }

    private static Size chooseOptimalSize(Size[] choices) {
        if (choices == null || choices.length == 0) return new Size(1280, 720);
        Size best = choices[0];
        int bestScore = Integer.MAX_VALUE;
        for (Size s : choices) {
            if (s.getWidth() < 640 || s.getHeight() < 480) continue;
            if (s.getWidth() > 1920) continue;
            int score = Math.abs(s.getWidth() - 1280) + Math.abs(s.getHeight() - 720);
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        return best;
    }

    private void createPreviewSession() {
        if (cameraDevice == null || imageReader == null || !textureView.isAvailable()) return;
        try {
            SurfaceTexture st = textureView.getSurfaceTexture();
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            Surface previewSurface = new Surface(st);
            Surface readerSurface = imageReader.getSurface();

            previewRequestBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewRequestBuilder.addTarget(previewSurface);
            previewRequestBuilder.addTarget(readerSurface);
            previewRequestBuilder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);

            cameraDevice.createCaptureSession(
                    Arrays.asList(previewSurface, readerSurface),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession session) {
                            if (cameraDevice == null) return;
                            captureSession = session;
                            try {
                                captureSession.setRepeatingRequest(previewRequestBuilder.build(), null, bgHandler);
                            } catch (CameraAccessException ignored) {
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession session) {
                            mainHandler.post(() -> Toast.makeText(
                                    QrScanActivity.this, "预览会话配置失败", Toast.LENGTH_SHORT).show());
                        }
                    },
                    bgHandler);
        } catch (CameraAccessException ignored) {
        }
    }

    private void configureTransform(int viewWidth, int viewHeight) {
        if (viewWidth == 0 || viewHeight == 0) return;
        Matrix matrix = new Matrix();
        RectF viewRect = new RectF(0, 0, viewWidth, viewHeight);
        float centerX = viewRect.centerX();
        float centerY = viewRect.centerY();

        // Portrait preview scaling: sensor landscape vs portrait view
        float bufW = sensorOrientation == 90 || sensorOrientation == 270
                ? previewSize.getHeight()
                : previewSize.getWidth();
        float bufH = sensorOrientation == 90 || sensorOrientation == 270
                ? previewSize.getWidth()
                : previewSize.getHeight();
        float scale = Math.max(viewWidth / bufW, viewHeight / bufH);
        matrix.postScale((bufW * scale) / viewWidth, (bufH * scale) / viewHeight, centerX, centerY);
        mainHandler.post(() -> textureView.setTransform(matrix));
    }

    private void toggleTorch() {
        if (!hasFlash || captureSession == null || previewRequestBuilder == null) return;
        torchOn = !torchOn;
        try {
            previewRequestBuilder.set(
                    CaptureRequest.FLASH_MODE,
                    torchOn ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
            captureSession.setRepeatingRequest(previewRequestBuilder.build(), null, bgHandler);
            torchBtn.setText(torchOn ? "手电筒: 开" : "手电筒: 关");
        } catch (CameraAccessException ignored) {
        }
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || scanDone.get()) return;
            long now = System.currentTimeMillis();
            if (now - lastDecodeAt < 140L) return;
            lastDecodeAt = now;

            Image.Plane yPlane = image.getPlanes()[0];
            int width = image.getWidth();
            int height = image.getHeight();
            int rowStride = yPlane.getRowStride();
            int pixelStride = yPlane.getPixelStride();
            ByteBuffer buffer = yPlane.getBuffer();

            byte[] yData = new byte[width * height];
            if (pixelStride == 1 && rowStride == width) {
                buffer.get(yData, 0, yData.length);
            } else {
                byte[] rowBuf = new byte[rowStride];
                for (int r = 0; r < height; r++) {
                    int remaining = buffer.remaining();
                    int toRead = Math.min(rowStride, remaining);
                    buffer.get(rowBuf, 0, toRead);
                    for (int c = 0; c < width; c++) {
                        int idx = c * pixelStride;
                        if (idx < toRead) {
                            yData[r * width + c] = rowBuf[idx];
                        }
                    }
                }
            }

            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                    yData, width, height, 0, 0, width, height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = qrReader.decode(bitmap, decodeHints);
            if (result != null && result.getText() != null && !result.getText().trim().isEmpty()) {
                if (scanDone.compareAndSet(false, true)) {
                    String text = result.getText().trim();
                    mainHandler.post(() -> onQrSuccess(text));
                }
            }
        } catch (Exception ignored) {
            // NotFoundException / ChecksumException / FormatException expected on non-QR frames
        } finally {
            qrReader.reset();
            if (image != null) {
                image.close();
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void onQrSuccess(String text) {
        try {
            Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vib != null) {
                if (Build.VERSION.SDK_INT >= 26) {
                    vib.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vib.vibrate(60);
                }
            }
        } catch (Exception ignored) {
        }
        Intent res = new Intent();
        res.putExtra(EXTRA_QR_TEXT, text);
        setResult(RESULT_OK, res);
        finish();
    }

    private void closeCamera() {
        if (captureSession != null) {
            try {
                captureSession.close();
            } catch (Exception ignored) {
            }
            captureSession = null;
        }
        if (cameraDevice != null) {
            try {
                cameraDevice.close();
            } catch (Exception ignored) {
            }
            cameraDevice = null;
        }
        if (imageReader != null) {
            try {
                imageReader.close();
            } catch (Exception ignored) {
            }
            imageReader = null;
        }
    }

    private static class ViewfinderOverlayView extends View {
        private final Paint scrimPaint = new Paint();
        private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint cornerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

        ViewfinderOverlayView(Context context) {
            super(context);
            scrimPaint.setColor(0x9905070C);
            borderPaint.setStyle(Paint.Style.STROKE);
            borderPaint.setColor(0x55FFFFFF);
            borderPaint.setStrokeWidth(2f);

            cornerPaint.setStyle(Paint.Style.STROKE);
            cornerPaint.setColor(Color.parseColor("#38BDF8"));
            cornerPaint.setStrokeWidth(8f);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            int w = getWidth();
            int h = getHeight();
            float boxSize = Math.min(w, h) * 0.66f;
            float left = (w - boxSize) / 2f;
            float top = (h - boxSize) / 2f;
            float right = left + boxSize;
            float bottom = top + boxSize;

            canvas.drawRect(0, 0, w, top, scrimPaint);
            canvas.drawRect(0, bottom, w, h, scrimPaint);
            canvas.drawRect(0, top, left, bottom, scrimPaint);
            canvas.drawRect(right, top, w, bottom, scrimPaint);
            canvas.drawRect(left, top, right, bottom, borderPaint);

            float c = 36f;
            canvas.drawLine(left, top, left + c, top, cornerPaint);
            canvas.drawLine(left, top, left, top + c, cornerPaint);
            canvas.drawLine(right - c, top, right, top, cornerPaint);
            canvas.drawLine(right, top, right, top + c, cornerPaint);
            canvas.drawLine(left, bottom - c, left, bottom, cornerPaint);
            canvas.drawLine(left, bottom, left + c, bottom, cornerPaint);
            canvas.drawLine(right - c, bottom, right, bottom, cornerPaint);
            canvas.drawLine(right, bottom - c, right, bottom, cornerPaint);
        }
    }
}
