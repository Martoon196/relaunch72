<?php
/**
 * Server-to-server request authentication.
 *
 * Relaunch72 signs every request with the shared connection key:
 *   X-R72-Timestamp: unix seconds
 *   X-R72-Signing:   path-query-1
 *   X-R72-Signature: hex(HMAC-SHA256(key, "{timestamp}.{METHOD}.{path?query}.{sha256hex(body)}"))
 *
 * This is the existing Relaunch72 content-API signature with one explicit, versioned
 * strengthening: the signed string covers the query string as well as the path, so
 * status/check parameters (article, version, brand, destination) cannot be altered.
 * Requests older or newer than five minutes are refused.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Signature {
	const WINDOW = 300;
	const SCHEME = 'path-query-1';

	/** The request target exactly as received (path plus raw query). */
	public static function request_target() {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- compared byte-for-byte inside an HMAC, never output.
		$hash = strpos( $uri, '#' );
		if ( false !== $hash ) {
			$uri = substr( $uri, 0, $hash );
		}
		return '' === $uri ? '/' : $uri;
	}

	public static function sign( $secret, $timestamp, $method, $target, $body ) {
		return hash_hmac( 'sha256', $timestamp . '.' . strtoupper( $method ) . '.' . $target . '.' . hash( 'sha256', $body ), $secret );
	}

	/**
	 * @param WP_REST_Request $request
	 * @return true|WP_Error
	 */
	public static function verify( $request ) {
		$secret = R72Pub_Settings::secret();
		if ( '' === $secret ) {
			return new WP_Error( 'r72_not_connected', 'This site has no Relaunch72 connection key.', array( 'status' => 401 ) );
		}
		$timestamp = (string) $request->get_header( 'x_r72_timestamp' );
		$signature = strtolower( (string) $request->get_header( 'x_r72_signature' ) );
		$scheme    = (string) $request->get_header( 'x_r72_signing' );
		if ( self::SCHEME !== $scheme || ! preg_match( '/^[0-9]{9,11}$/', $timestamp ) || ! preg_match( '/^[0-9a-f]{64}$/', $signature ) ) {
			return new WP_Error( 'r72_bad_signature', 'Unsigned or unsupported request.', array( 'status' => 401 ) );
		}
		if ( abs( time() - (int) $timestamp ) > self::WINDOW ) {
			return new WP_Error( 'r72_stale_signature', 'The signed request is outside the five-minute window. Check both servers\' clocks.', array( 'status' => 401 ) );
		}
		$expected = self::sign( $secret, $timestamp, $request->get_method(), self::request_target(), (string) $request->get_body() );
		if ( ! hash_equals( $expected, $signature ) ) {
			return new WP_Error( 'r72_bad_signature', 'The request signature is not valid for this site.', array( 'status' => 401 ) );
		}
		return true;
	}
}
