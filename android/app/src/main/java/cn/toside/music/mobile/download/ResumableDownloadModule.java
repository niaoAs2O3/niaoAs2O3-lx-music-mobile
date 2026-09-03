package cn.toside.music.mobile.download;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

public class ResumableDownloadModule extends ReactContextBaseJavaModule {
  private static final String PROGRESS_EVENT = "resumable-download-progress";
  private final ReactApplicationContext reactContext;
  private static final int MAX_ATTEMPTS = 3;
  private final OkHttpClient client = new OkHttpClient.Builder()
    .connectTimeout(45, TimeUnit.SECONDS)
    .readTimeout(45, TimeUnit.SECONDS)
    .writeTimeout(45, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
    .build();
  private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

  ResumableDownloadModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return "ResumableDownloadModule";
  }

  @ReactMethod
  public void addListener(String eventName) {}

  @ReactMethod
  public void removeListeners(Integer count) {}

  @ReactMethod
  public void download(String id, String url, String filePath, Promise promise) {
    new Thread(() -> downloadFile(id, url, filePath, promise), "LX-resumable-download").start();
  }

  @ReactMethod
  public void cancel(String id) {
    Call call = calls.get(id);
    if (call != null) call.cancel();
  }

  private void downloadFile(String id, String url, String filePath, Promise promise) {
    File target = new File(filePath);
    File parent = target.getParentFile();
    if (parent != null && !parent.exists() && !parent.mkdirs()) {
      promise.reject("CREATE_DIRECTORY_FAILED", "Unable to create download directory");
      return;
    }

    for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      long existingBytes = target.exists() ? target.length() : 0;
      Request.Builder requestBuilder = new Request.Builder()
        .url(url)
        .header("User-Agent", "Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36");
      if (existingBytes > 0) requestBuilder.header("Range", "bytes=" + existingBytes + "-");

      Call call = client.newCall(requestBuilder.build());
      calls.put(id, call);
      try (Response response = call.execute()) {
        int statusCode = response.code();
        if (statusCode < 200 || statusCode >= 300) {
          promise.reject("HTTP_" + statusCode, "HTTP " + statusCode);
          return;
        }

        boolean append = existingBytes > 0 && statusCode == 206 && hasExpectedRange(response, existingBytes);
        long startBytes = append ? existingBytes : 0;
        ResponseBody body = response.body();
        if (body == null) {
          promise.reject("EMPTY_RESPONSE", "Download response has no body");
          return;
        }
        long totalBytes = getTotalBytes(response, body.contentLength(), startBytes);
        emitProgress(id, startBytes, totalBytes);

        try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(target, append)) {
          byte[] buffer = new byte[32 * 1024];
          long downloaded = startBytes;
          long lastProgressTime = 0;
          int count;
          while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
            downloaded += count;
            long now = System.currentTimeMillis();
            if (now - lastProgressTime >= 500) {
              lastProgressTime = now;
              emitProgress(id, downloaded, totalBytes);
            }
          }
          output.flush();
          emitProgress(id, downloaded, totalBytes);
          if (totalBytes > 0 && downloaded != totalBytes) {
            promise.reject("INCOMPLETE_RESPONSE", "Downloaded " + downloaded + " of " + totalBytes + " bytes");
            return;
          }
          WritableMap result = Arguments.createMap();
          result.putInt("statusCode", statusCode);
          result.putDouble("downloaded", downloaded);
          result.putDouble("total", totalBytes);
          result.putBoolean("resumed", append);
          promise.resolve(result);
          return;
        }
      } catch (IOException error) {
        if (call.isCanceled()) {
          promise.reject("CANCELED", "Download canceled");
          return;
        }
        if (attempt == MAX_ATTEMPTS - 1) {
          promise.reject("DOWNLOAD_FAILED", error.getMessage(), error);
          return;
        }
        try {
          Thread.sleep(750L * (attempt + 1));
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          promise.reject("INTERRUPTED", "Download interrupted", interrupted);
          return;
        }
      } finally {
        calls.remove(id, call);
      }
    }
  }

  private boolean hasExpectedRange(Response response, long existingBytes) {
    String contentRange = response.header("Content-Range");
    return contentRange != null && contentRange.startsWith("bytes " + existingBytes + "-");
  }

  private long getTotalBytes(Response response, long contentLength, long startBytes) {
    String contentRange = response.header("Content-Range");
    if (contentRange != null) {
      int slashIndex = contentRange.lastIndexOf('/');
      if (slashIndex >= 0) {
        try {
          return Long.parseLong(contentRange.substring(slashIndex + 1));
        } catch (NumberFormatException ignored) {}
      }
    }
    return contentLength >= 0 ? startBytes + contentLength : 0;
  }

  private void emitProgress(String id, long downloaded, long total) {
    if (!reactContext.hasActiveReactInstance()) return;
    WritableMap progress = Arguments.createMap();
    progress.putString("id", id);
    progress.putDouble("downloaded", downloaded);
    progress.putDouble("total", total);
    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(PROGRESS_EVENT, progress);
  }
}
