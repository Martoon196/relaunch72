<?php
/**
 * Signed REST routes (namespace relaunch72/v1). Every route requires a valid
 * Relaunch72 signature; nothing here is available to browsers or other plugins.
 *
 *   GET  /status?check=1&brand=<uuid>&destination=<uuid>   connection + capability check (writes nothing but the pairing)
 *   GET  /status?article=<uuid>&version=<uuid>              read-only reconciliation (works while writes are paused)
 *   POST /publish                                           exact-version delivery
 *
 * Responses never contain the connection key, user data or server paths.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Rest {
	const NS = 'relaunch72/v1';

	public static function register_routes() {
		register_rest_route(
			self::NS,
			'/status',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'status' ),
				'permission_callback' => array( 'R72Pub_Signature', 'verify' ),
			)
		);
		register_rest_route(
			self::NS,
			'/publish',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'publish' ),
				'permission_callback' => array( 'R72Pub_Signature', 'verify' ),
			)
		);
	}

	public static function endpoint() {
		return rest_url( self::NS . '/publish' );
	}

	private static function respond( $result ) {
		if ( is_wp_error( $result ) ) {
			$data   = $result->get_error_data();
			$status = is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 409;
			$body   = array(
				'error' => $result->get_error_message(),
				'code'  => $result->get_error_code(),
			);
			if ( is_array( $data ) && isset( $data['status'] ) && is_string( $data['status'] ) ) {
				$body['status'] = $data['status'];
			}
			$response = new WP_REST_Response( $body, $status );
		} else {
			$response = new WP_REST_Response( $result['body'], $result['code'] );
		}
		$response->header( 'Cache-Control', 'no-store, private' );
		$response->header( 'X-Robots-Tag', 'noindex' );
		return $response;
	}

	public static function status( WP_REST_Request $request ) {
		if ( $request->get_param( 'check' ) ) {
			return self::respond( self::check( (string) $request->get_param( 'brand' ), (string) $request->get_param( 'destination' ) ) );
		}
		return self::respond( R72Pub_Publisher::status( (string) $request->get_param( 'article' ), (string) $request->get_param( 'version' ) ) );
	}

	/** Connection check. Publishes nothing. Binds the brand pairing on first success. */
	public static function check( $brand_id, $destination_id ) {
		$bound = R72Pub_Settings::bind_pairing( $brand_id, $destination_id );
		if ( is_wp_error( $bound ) ) {
			return $bound;
		}
		$eval = R72Pub_Capabilities::evaluate();
		$caps = R72Pub_Capabilities::capabilities();
		$body = array(
			'ok'        => true,
			'protocol'  => R72PUB_PROTOCOL,
			'plugin'    => array( 'name' => 'Relaunch72 Publisher & SEO', 'version' => R72PUB_VERSION ),
			'wordpress' => array(
				'version'     => get_bloginfo( 'version' ),
				'php'         => PHP_VERSION,
				'supported'   => version_compare( get_bloginfo( 'version' ), R72PUB_MIN_WP, '>=' ) && version_compare( PHP_VERSION, R72PUB_MIN_PHP, '>=' ),
				'writesPaused' => R72Pub_Settings::paused(),
				'seo'         => array(
					'mode'     => $eval['seo']['mode'],
					'provider' => $eval['seo']['provider'],
					'message'  => $eval['seo']['message'],
				),
				'sitemap'     => array( 'owner' => $eval['sitemap']['owner'], 'url' => $eval['sitemap']['url'] ),
				'permalink'   => R72Pub_Capabilities::permalink()['structure'],
			),
			'holds'     => $eval['blocking'],
			'warnings'  => $eval['warnings'],
		);
		if ( $caps ) {
			$body['capabilities'] = $caps;
		}
		return array( 'code' => 200, 'body' => $body );
	}

	public static function publish( WP_REST_Request $request ) {
		// A byte-identical signed request is a replay or a duplicate send. It cannot do
		// anything new (delivery is idempotent), but answer "busy" so the sender reconciles.
		$seen = 'r72pub_seen_' . md5( (string) $request->get_header( 'x_r72_signature' ) );
		if ( get_transient( $seen ) ) {
			return self::respond( new WP_Error( 'r72_replayed', 'Duplicate signed request. Reconcile with a status check.', array( 'status' => 429 ) ) );
		}
		set_transient( $seen, 1, 2 * R72Pub_Signature::WINDOW );
		return self::respond( R72Pub_Publisher::publish( (string) $request->get_body() ) );
	}
}
